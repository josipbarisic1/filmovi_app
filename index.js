require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const mysql = require('mysql');
//const helmet = require('helmet');
const csurf = require('csurf');
const sanitizeHtml = require('sanitize-html');

const OpenAI = require("openai");
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    dangerouslyAllowBrowser: false,
});



const app = express();
const port = 3000;
const globalSeasonCache = {};

function getScoreColor(score) {
    if (!score || isNaN(score) || score == 0) return '128, 128, 128';
    const red = Math.min(255, Math.max(0, 255 - Math.round((score / 10) * 255)));
    const green = Math.min(255, Math.max(0, Math.round((score / 10) * 255)));
    return `${red}, ${green}, 0`;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'process.env.SESSION_SECRET',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
}));
app.use((req, res, next) => {
    res.locals.session = req.session || {};
    res.locals.currentUrl = req.originalUrl;
    next();
});

app.use(csurf());

app.use((req, res, next) => {
    res.locals.csrfToken = req.csrfToken();
    next();
});

app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        res.status(403);
        res.send('CSRF zaštita: Nevažeći token.');
    } else {
        next(err);
    }
});

/*
//Generiraj secret
const crypto = require('crypto');

const secret = crypto.randomBytes(64).toString('hex');
console.log('Generirani secret:', secret);


//Hashiraj lozinku
const plainPassword = 'lozinka123';
const saltRounds = 10;

bcrypt.hash(plainPassword, saltRounds, (err, hash) => {
    if (err) {
        console.error('Greška prilikom hashiranja:', err);
    } else {
        console.log('Hashirana lozinka:', hash);
    }
});
*/

app.get('/ai-models', async (req, res) => {
    try {
        const models = await openai.models.list();
        res.json(models);
    } catch (error) {
        console.error("Error fetching models:", error);
        res.status(500).send("Error fetching models.");
    }
});

function requireLogin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).send('Login to use this');
    }
    next();
}

app.get('/ai', requireLogin, (req, res) => {
    res.render('ai', { csrfToken: req.csrfToken() });
});

app.get('/ai-info', (req, res) => {
    res.render('ai_info');
});

const aiRequests = {};

async function getSimilarMovies(movieId) {
    const apiKey = process.env.TMDB_API_KEY;
    const similarUrl = `https://api.themoviedb.org/3/movie/${movieId}/similar?api_key=${apiKey}&language=en-US`;

    try {
        const response = await axios.get(similarUrl);
        return response.data.results || [];
    } catch (error) {
        return [];
    }
}

app.post('/ai-recommend', requireLogin, async (req, res) => {    
    const { userMessage, excludeWatched } = req.body;
    const userId = req.session.userId;
    const userRole = req.session.role || "user"; 

    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    
    const watchedMovies = await new Promise((resolve, reject) => {
        connection.query(
            "SELECT sadrzaj_id FROM pogledano WHERE korisnik_id = ?", 
            [userId], 
            (err, results) => {
                if (err) reject(err);
                else resolve(results.map(row => row.sadrzaj_id));
            }
        );
    });
    

    if (!userMessage) {
        return res.status(400).json({ error: "Message is required." });
    }

    if (userRole !== "admin") {
        const today = new Date().toISOString().split("T")[0];

        if (!aiRequests[userId]) {
            aiRequests[userId] = { date: today, count: 0 };
        }

        if (aiRequests[userId].date !== today) {
            aiRequests[userId] = { date: today, count: 0 };
        }

        if (aiRequests[userId].count >= 3) {
            return res.status(429).json({ error: "You have reached the daily AI request limit (3 requests per day)." });
        }

        aiRequests[userId].count++;
    }

    try {
        const systemMessage = `You are a movie/TV show recommendation AI. Your job is to recommend a movie or TV show based on user input. Always answer in the users language.
    
        Always format your response exactly like this:
        Title: "Inception"
        Year: 2010
        Language: English
        Reason: "A mind-bending thriller with stunning visuals."
        
        At the end say: "Here's a link to the movie" OR "Here's a link to the TV show".`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemMessage },
                { role: "user", content: userMessage }
            ],
            max_tokens: 120,
            temperature: 0.7
        });

        const aiResponse = completion.choices[0].message.content;

        if (aiResponse.includes("I only answer movie-related questions")) {
            throw new Error("Invalid query: AI only answers about movies/TV.");
        }

        const titleMatch = aiResponse.match(/Title:\s*"([^"]+)"/);
        const yearMatch = aiResponse.match(/Year:\s*(\d{4})/);
        const languageMatch = aiResponse.match(/Language:\s*([\w-]+)/);

        if (!titleMatch || !yearMatch || !languageMatch) {
            return res.json({ recommendation: "I'm sorry, but I cannot assist with that.", link: null });
        }

        let recommendedTitle = titleMatch[1].trim();
        let recommendedYear = parseInt(yearMatch[1].trim());
        let recommendedLanguage = languageMatch[1].trim();

        recommendedLanguage = "en-US";

        recommendedTitle = recommendedTitle.replace(/[^a-zA-Z0-9 ]/g, "");

        const apiKey = process.env.TMDB_API_KEY;
        const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${encodeURIComponent(recommendedTitle)}&language=${recommendedLanguage}`;

        const searchResponse = await axios.get(searchUrl);
        const searchResults = searchResponse.data.results;

        if (!searchResults || searchResults.length === 0) {
            return res.json({ recommendation: aiResponse, link: null });
        }

        let filteredResults = searchResults
        .filter(item => Math.abs(parseInt(item.release_date?.substr(0, 4)) - recommendedYear) <= 3);
            
        let finalResults = excludeWatched
            ? filteredResults.filter(item => !watchedMovies.includes(parseInt(item.id)))
            : filteredResults;
        
        if (finalResults.length === 0) {
            finalResults = filteredResults;
        }
        
        const bestMatch = finalResults.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))[0];
    
    

        if (!bestMatch) {
            return res.json({ recommendation: "Something went wrong, please try again.", link: null });
        }
            


        const mediaType = bestMatch.media_type === 'movie' ? 'film' : 'serija';
        const mediaId = bestMatch.id;
        const mediaLink = `/${mediaType}/${mediaId}`;


        res.json({ recommendation: aiResponse, link: mediaLink });
    } catch (error) {
        console.error("[SERVER ERROR] AI processing failed:", error);
        res.status(400).json({ error: "Invalid input. AI only answers movie-related questions." });
    }
});



async function getSeriesDetails(serijaId) {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/tv/${serijaId}?api_key=${apiKey}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error('Error in getSeriesDetails:', error);
        throw error;
    }
}

async function getSeasonDetails(serijaId, sezonaId) {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/tv/${serijaId}/season/${sezonaId}?api_key=${apiKey}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error('Error in getSeasonDetails:', error);
        throw error;
    }
}

async function getEpisodeDetails(serijaId, sezonaId, epizodaId) {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/tv/${serijaId}/season/${sezonaId}/episode/${epizodaId}?api_key=${apiKey}&append_to_response=credits`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error('Error in getEpisodeDetails:', error);
        throw error;
    }
}


app.get('/', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;

    try {
        const [popularMoviesRes, popularTVShowsRes, trendingRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&sort_by=popularity.desc&vote_count.gte=500`),
            axios.get(`https://api.themoviedb.org/3/discover/tv?api_key=${apiKey}&sort_by=popularity.desc&vote_count.gte=500`),
            axios.get(`https://api.themoviedb.org/3/trending/all/week?api_key=${apiKey}`)
        ]);

        const MIN_VOTE_COUNT = 500;
        const excludedGenres = [10767, 10763, 99]; 

        const popularMovies = popularMoviesRes.data.results
            .filter(movie => movie.vote_count >= MIN_VOTE_COUNT && movie.title)
            .slice(0, 10);

        const popularTVShows = popularTVShowsRes.data.results
            .filter(show => 
                show.vote_count >= MIN_VOTE_COUNT &&
                Array.isArray(show.genre_ids) && 
                !show.genre_ids.some(genre => excludedGenres.includes(genre)) &&
                show.name 
            )
            .slice(0, 10);

        const trending = trendingRes.data.results.slice(0, 10);

        res.render('pocetna', { popularMovies, trending, popularTVShows });
    } catch (error) {
        console.error("Error fetching movies and TV shows:", error);
        res.render('pocetna', { popularMovies: [], trending: [], popularTVShows: [] });
    }
});


app.get('/test', (req, res) => {
    res.render('partials/header', { session: req.session });
});

function containsInvalidCharactersEmail(text) {
    const emailPattern = /^[a-zA-Z0-9@.]+$/;
    return !emailPattern.test(text);
}

function containsInvalidCharactersUsername(text) {
    const usernamePattern = /^[a-zA-Z0-9]+$/;
    return !usernamePattern.test(text);
}

function containsInvalidCharactersGeneral(text) {
    const invalidPattern = /[<>\/\(\)\{\}\[\]=;:]/g;
    return text !== sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }) || invalidPattern.test(text);
}

app.post('/register', async (req, res) => {
    const { username, email_address, age, phone_number, gender, password, nadimak } = req.body;

    if (!username || !email_address || !password) {
        return res.status(400).send("Username, email, and password are required.");
    }

    if (!/^[A-Za-z0-9]+$/.test(username)) {
        return res.status(400).send("Invalid username. Only letters and numbers are allowed.");
    }

    if (password.length < 8) {
        return res.status(400).send("Password must be at least 8 characters long.");
    }

    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email_address)) {
        return res.status(400).send("Invalid email format.");
    }

    if (phone_number && !/^\+?[0-9]{7,15}$/.test(phone_number)) {
        return res.status(400).send("Invalid phone number format.");
    }

    if (!nadimak || nadimak.length < 5) {
        return res.status(400).send("Nickname must be at least 5 characters long.");
    }
    
    if (containsInvalidCharactersUsername(username)) {
        return res.status(400).send("Invalid characters in username. Only letters and numbers are allowed.");
    }

    if (containsInvalidCharactersEmail(email_address)) {
        return res.status(400).send("Invalid email format.");
    }

    if (containsInvalidCharactersGeneral(nadimak) || containsInvalidCharactersGeneral(phone_number)) {
        return res.status(400).send("Invalid characters detected in nickname or phone number.");
    }
    
    const cleanUsername = sanitizeHtml(username);
    const cleanEmail = sanitizeHtml(email_address);
    const cleanPhone = sanitizeHtml(phone_number);
    const cleanNadimak = sanitizeHtml(nadimak);

    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    if (!cleanUsername || !cleanEmail || !password) {
        return res.status(400).send("Invalid input detected.");
    }

    connection.query(`SELECT * FROM korisnici WHERE username = ? OR email_address = ?`, [username, email_address], async (error, results) => {
        if (error) {
            console.error('Error checking username/email:', error);
            connection.end();
            return res.status(500).send('Database error.');
        }
    
        if (results.length > 0) {
            connection.end();
            let errorMessage = results.some(user => user.username === username) ? "Username already taken." : "Email already registered.";
            return res.render('register', {
                korisnik: null,
                csrfToken: req.csrfToken(),
                isEdit: false,
                errorMessage
            });
        }

        try {
            const hashedPassword = await bcrypt.hash(password, 10);

            const query = `
                INSERT INTO korisnici (username, email_address, age, phone_number, gender, password, nadimak, role, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'user', NOW())`;

            connection.query(query, [cleanUsername, cleanEmail, age, cleanPhone, gender, hashedPassword, cleanNadimak || null], (error) => {
                if (error) {
                    console.error('Error during registration:', error);
                    return res.status(500).send('Error while registering user.');
                }
                res.redirect('/login');
            });
        } catch (err) {
            console.error('Password hashing error:', err);
            res.status(500).send('Server error.');
        }
    });
});



app.get('/register', (req, res) => {
    res.render('register', 
        { 
            session: req.session,
            korisnik: null,
            csrfToken: req.csrfToken(),
            isEdit: false,
            errorMessage: null,
        });
});

app.get('/login', (req, res) => {
    let redirect = req.query.redirect || req.headers.referer || '/';
    const blockedRedirects = ['/register', '/login'];
    
    if (blockedRedirects.includes(new URL(redirect, 'http://localhost').pathname)) {
        redirect = '/';
    }

    res.render('login', { session: req.session, redirect });
});
app.post('/login', async (req, res) => {
    const username = sanitizeHtml(req.body.username);
    const password = req.body.password; 
    let redirect = req.body.redirect;

    if (containsInvalidCharactersUsername(username)) {
        return res.status(400).send("Invalid characters in username. Only letters and numbers are allowed.");
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    connection.query(
        `SELECT * FROM korisnici WHERE username = ?`,
        [username],
        async (error, results) => {
            connection.end();
            if (error || results.length === 0) {
                console.error('Error during login:', error);
                return res.status(401).send('Invalid username or password.');
            }

            const user = results[0];
            try {
                const passwordMatch = await bcrypt.compare(password, user.password);
                if (passwordMatch) {
                    req.session.userId = user.id;
                    req.session.username = user.username;
                    req.session.role = user.role;

                    const blockedRedirects = ['/register', '/login'];
                    if (blockedRedirects.includes(new URL(redirect, 'http://localhost').pathname)) {
                        redirect = '/';
                    }
                    res.redirect(redirect || '/');
                } else {
                    res.status(401).send('Invalid username or password.');
                }
            } catch (err) {
                console.error('Password check error:', err);
                res.status(500).send('Server error.');
            }
        }
    );
});

app.get('/logout', (req, res) => {
    const redirect = req.query.redirect || '/';
    req.session.destroy(() => {
        res.redirect(redirect);
    });
});

app.get('/profil', requireLogin, (req, res) => {
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.redirect('/login');
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const userQuery = `SELECT username, email_address, age, phone_number, gender, nadimak FROM korisnici WHERE id = ?`;

    connection.query(userQuery, [korisnikId], (error, userResults) => {
        if (error || userResults.length === 0) {
            connection.end();
            console.error('Error fetching user profile:', error);
            return res.status(500).send('Error loading profile.');
        }

        res.render('profil', {
            korisnik: userResults[0]
        });

        connection.end();
    });
});



app.get('/profile/edit', requireLogin, (req, res) => {
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.redirect('/login');
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const query = `SELECT username, email_address, age, phone_number, gender, nadimak FROM korisnici WHERE id = ?`;

    connection.query(query, [korisnikId], (error, results) => {
        connection.end();
        if (error || results.length === 0) {
            console.error('Error fetching user profile:', error);
            return res.status(500).send('Error loading profile.');
        }

        res.render('register', {
            korisnik: results[0],
            csrfToken: req.csrfToken(),
            isEdit: true,
            errorMessage: null,
        });
    });
});

app.post('/profile/update', requireLogin, (req, res) => {
    const { username, email_address, age, phone_number, gender, nadimak } = req.body;
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.status(401).send('Unauthorized');
    }

    if (containsInvalidCharactersUsername(username)) {
        return res.status(400).send("Invalid characters in username. Only letters and numbers are allowed.");
    }

    if (containsInvalidCharactersEmail(email_address)) {
        return res.status(400).send("Invalid email format.");
    }

    if (containsInvalidCharactersGeneral(nadimak) || containsInvalidCharactersGeneral(phone_number)) {
        return res.status(400).send("Invalid characters detected in nickname or phone number.");
    }

    const cleanUsername = sanitizeHtml(username);
    const cleanEmail = sanitizeHtml(email_address);
    const cleanPhone = sanitizeHtml(phone_number);
    const cleanNadimak = sanitizeHtml(nadimak);

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const query = `
        UPDATE korisnici 
        SET username = ?, email_address = ?, age = ?, phone_number = ?, gender = ?, nadimak = ?
        WHERE id = ?
    `;

    connection.query(query, [cleanUsername, cleanEmail, age, cleanPhone, gender, cleanNadimak, korisnikId], (error) => {
        connection.end();
        if (error) {
            console.error('Error updating profile:', error);
            return res.status(500).send('Error updating profile.');
        }
        res.redirect('/profil');
    });
});


app.get('/profile/lists', requireLogin, (req, res) => {
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.status(401).json({ error: "You must be logged in." });
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const listsQuery = `SELECT id, naziv, tip_popisa FROM popisi WHERE korisnik_id = ?`;
    const favoritesQuery = `SELECT sadrzaj_id, tip FROM favoriti WHERE korisnik_id = ?`;
    const watchedQuery = `SELECT sadrzaj_id, tip FROM pogledano WHERE korisnik_id = ?`;

    Promise.all([
        new Promise((resolve, reject) => {
            connection.query(listsQuery, [korisnikId], (err, results) => {
                if (err) reject(err);
                else resolve(results);
            });
        }),
        new Promise((resolve, reject) => {
            connection.query(favoritesQuery, [korisnikId], (err, results) => {
                if (err) reject(err);
                else resolve(results);
            });
        }),
        new Promise((resolve, reject) => {
            connection.query(watchedQuery, [korisnikId], (err, results) => {
                if (err) reject(err);
                else resolve(results);
            });
        })
    ])
    .then(([lists, favorites, watched]) => {
        connection.end();
        res.json({ lists, favorites, watched });
    })
    .catch(error => {
        connection.end();
        console.error("[ERROR FETCHING LISTS]", error);
        res.status(500).json({ error: "Error fetching lists." });
    });
});



app.get('/profile/reviews', requireLogin, (req, res) => {
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.status(401).json({ error: "You must be logged in." });
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const query = `
        SELECT tekst, ocjena, datum, film_id, serija_id
        FROM komentari WHERE korisnik_id = ? ORDER BY datum DESC`;

    connection.query(query, [korisnikId], (error, results) => {
        connection.end();
        if (error) {
            console.error("Error fetching reviews:", error);
            return res.status(500).json({ error: "Error fetching reviews." });
        }
        res.json(results);
    });
});

app.get('/api/search-autocomplete', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.json([]);

    const response = await axios.get(`https://api.themoviedb.org/3/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${query}`);

    res.json(response.data.results.map(item => ({
        name: item.title || item.name,
        id: item.id,
        type: item.media_type,
        year: item.release_date ? item.release_date.split("-")[0] : item.first_air_date ? item.first_air_date.split("-")[0] : "N/A"
    })));
});

app.get('/pretrazi', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const naziv = req.query.naziv || '';
    const category = req.query.category || 'movie';
    let page = parseInt(req.query.page) || 1;
    let genre = req.query.genre || '';
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    const language = req.query.language || '';

    try {
        let allResults = [];
        const pageSize = 20;
        const maxPagesToFetch = 10;
        const excludeGenres = category === 'tv' ? '10767,10763' : '';

        const genreResponse = await axios.get(`https://api.themoviedb.org/3/genre/${category}/list?api_key=${apiKey}`);
        const availableGenres = genreResponse.data.genres.map(g => g.id.toString());

        if (genre && !availableGenres.includes(genre)) {
            genre = '';
        }

        if (naziv) {
            for (let i = 1; i <= maxPagesToFetch; i++) {
                const searchUrl = `https://api.themoviedb.org/3/search/${category}?api_key=${apiKey}&query=${encodeURIComponent(naziv)}&page=${i}`;
                const searchResponse = await axios.get(searchUrl);
                allResults = allResults.concat(searchResponse.data.results);
                if (i >= searchResponse.data.total_pages) break;
            }
        } else {
            for (let i = 1; i <= maxPagesToFetch; i++) {
                let discoverUrl = `https://api.themoviedb.org/3/discover/${category}?api_key=${apiKey}&page=${i}`;
                if (genre) discoverUrl += `&with_genres=${genre}`;
                if (excludeGenres) discoverUrl += `&without_genres=${excludeGenres}`;
                if (startDate && endDate) {
                    discoverUrl += category === 'movie'
                        ? `&primary_release_date.gte=${startDate}&primary_release_date.lte=${endDate}`
                        : `&first_air_date.gte=${startDate}&first_air_date.lte=${endDate}`;
                }
                if (language) discoverUrl += `&with_original_language=${language}`;

                const discoverResponse = await axios.get(discoverUrl);
                allResults = allResults.concat(discoverResponse.data.results);
                if (i >= discoverResponse.data.total_pages) break;
            }
        }

        allResults = allResults.filter(item => {
            const matchesGenre = genre ? item.genre_ids.includes(parseInt(genre)) : true;
            const releaseDate = item.release_date || item.first_air_date || '';
            const matchesDate = (startDate && endDate && releaseDate)
                ? (releaseDate >= startDate && releaseDate <= endDate)
                : true;
            const matchesLanguage = language ? item.original_language === language : true;
            return matchesGenre && matchesDate && matchesLanguage;
        });

        const totalFilteredResults = allResults.length;
        const totalPages = Math.max(1, Math.ceil(totalFilteredResults / pageSize));
        page = Math.min(page, totalPages);

        const results = allResults.slice((page - 1) * pageSize, page * pageSize);

        const pagination = generatePagination(page, totalPages);

        res.render('pretrazi_film', {
            data: { results, page, total_pages: totalPages },
            naziv,
            category,
            pagination,
            page,
            totalPages,
            genres: genreResponse.data.genres,
            selectedGenre: genre,
            startDate,
            endDate,
            language
        });
    } catch (error) {
        console.error("Greška kod dohvaćanja podataka:", error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
});


function generatePagination(currentPage, totalPages) {
    const maxVisiblePages = 5;
    let pages = [];

    if (totalPages <= 1) return [];

    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    if (startPage > 1) pages.push(1);
    if (startPage > 2) pages.push("...");

    for (let i = startPage; i <= endPage; i++) {
        pages.push(i);
    }

    if (endPage < totalPages - 1) pages.push("...");
    if (endPage < totalPages) pages.push(totalPages);

    return pages;
}

const updateRenderParams = async (url, title, category, req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const page = parseInt(req.query.page) || 1;
    const genre = req.query.genre || '';
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';
    const language = req.query.language || '';
    const runtimeMin = req.query.runtimeMin || '';
    const runtimeMax = req.query.runtimeMax || '';

    let filterUrl = `${url}&page=${page}`;

    if (genre) filterUrl += `&with_genres=${genre}`;
    if (startDate && endDate) {
        filterUrl += category === 'movie' 
            ? `&primary_release_date.gte=${startDate}&primary_release_date.lte=${endDate}`
            : `&first_air_date.gte=${startDate}&first_air_date.lte=${endDate}`;
    }
    if (language) filterUrl += `&with_original_language=${language}`;
    if (runtimeMin && runtimeMax) filterUrl += `&with_runtime.gte=${runtimeMin}&with_runtime.lte=${runtimeMax}`;

    try {
        const response = await axios.get(filterUrl);
        const data = response.data;
        const totalPages = data.total_pages;

        const genreResponse = await axios.get(`https://api.themoviedb.org/3/genre/${category}/list?api_key=${apiKey}`);
        const genres = genreResponse.data.genres;

        res.render('top_lista', {
            title,
            data,
            category,
            page,
            totalPages,
            loadMore: page < totalPages,
            nextPage: page + 1,
            genres,
            selectedGenre: genre,
            startDate,
            endDate, 
            language,
            runtimeMin,
            runtimeMax       
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
};

const formatDate = (date) => date.toISOString().split('T')[0];

app.get('/:category/latest', async (req, res) => {
    const category = req.params.category;
    const apiKey = process.env.TMDB_API_KEY;
    const page = parseInt(req.query.page) || 1;
    const genre = req.query.genre || '';
    const language = req.query.language || '';
    const runtimeMin = req.query.runtimeMin || '';
    const runtimeMax = req.query.runtimeMax || '';

    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    let url = `https://api.themoviedb.org/3/discover/${category}?api_key=${apiKey}&page=${page}&sort_by=popularity.desc`;

    if (category === 'movie') {
        url += `&primary_release_date.gte=${formatDate(thirtyDaysAgo)}&primary_release_date.lte=${formatDate(today)}`;
        url += `&with_release_type=2|3`;
    } else if (category === 'tv') {
        url += `&first_air_date.gte=${formatDate(today)}&first_air_date.lte=${formatDate(today)}`;
        url += `&with_watch_monetization_types=flatrate|free|ads|rent|buy`;
    } else {
        return res.status(400).send('Invalid category.');
    }

    if (genre) url += `&with_genres=${genre}`;
    if (language) url += `&with_original_language=${language}`;
    if (runtimeMin && runtimeMax) url += `&with_runtime.gte=${runtimeMin}&with_runtime.lte=${runtimeMax}`;

    await updateRenderParams(url, `Latest ${category === 'movie' ? 'Movies' : 'TV Shows'}`, category, req, res);
});

app.get('/:category/most-viewed', async (req, res) => {
    const category = req.params.category;
    const apiKey = process.env.TMDB_API_KEY;
    const page = parseInt(req.query.page) || 1;
    const genre = req.query.genre || '';
    const language = req.query.language || '';
    const runtimeMin = req.query.runtimeMin || '';
    const runtimeMax = req.query.runtimeMax || '';
    const minVotes = 750;

    let url = `https://api.themoviedb.org/3/discover/${category}?api_key=${apiKey}&page=${page}&sort_by=popularity.desc&vote_count.gte=${minVotes}`;

    if (genre) url += `&with_genres=${genre}`;
    if (language) url += `&with_original_language=${language}`;
    if (runtimeMin && runtimeMax) url += `&with_runtime.gte=${runtimeMin}&with_runtime.lte=${runtimeMax}`;

    await updateRenderParams(url, `Most Viewed ${category === 'movie' ? 'Movies' : 'TV Shows'}`, category, req, res);
});

app.get('/:category/top-rated', async (req, res) => {
    const category = req.params.category;
    const apiKey = process.env.TMDB_API_KEY;
    const page = parseInt(req.query.page) || 1;
    const genre = req.query.genre || '';
    const language = req.query.language || '';
    const runtimeMin = req.query.runtimeMin || '';
    const runtimeMax = req.query.runtimeMax || '';
    const minVotes = 500;

    let url = `https://api.themoviedb.org/3/discover/${category}?api_key=${apiKey}&page=${page}&sort_by=vote_average.desc&vote_count.gte=${minVotes}`;

    if (genre) url += `&with_genres=${genre}`;
    if (language) url += `&with_original_language=${language}`;
    if (runtimeMin && runtimeMax) url += `&with_runtime.gte=${runtimeMin}&with_runtime.lte=${runtimeMax}`;

    await updateRenderParams(url, `Top Rated ${category === 'movie' ? 'Movies' : 'TV Shows'}`, category, req, res);
});


app.get('/:category/alphabetical', async (req, res) => {
    const category = req.params.category;
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/discover/${category}?api_key=${apiKey}&sort_by=original_title.asc`;
    await updateRenderParams(url, `Alphabetical ${category === 'movie' ? 'Movies' : 'TV Shows'}`, category, req, res);
});


app.get('/popisi', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const username = req.session.username;

    if (!username) return res.status(401).send('You must be logged in.');

    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    try {
        const [popisi, favoriti, pogledano] = await Promise.all([
            queryDatabase(connection, 'SELECT id, naziv, tip_popisa, sadrzaj, JSON_LENGTH(sadrzaj) AS broj_stavki, created_at FROM popisi WHERE korisnik_id = ?', [userId]),
            queryDatabase(connection, 'SELECT sadrzaj_id, tip FROM favoriti WHERE korisnik_id = ?', [userId]),
            queryDatabase(connection, 'SELECT sadrzaj_id, tip FROM pogledano WHERE korisnik_id = ?', [userId])
        ]);

        for (let popis of popisi) {
            popis.sadrzaj = popis.sadrzaj ? JSON.parse(popis.sadrzaj) : [];
        }

        const fetchContentDetails = async (items) => {
            return await Promise.all(items.map(async (item) => {
                try {
                    const apiUrl = item.tip === "film"
                        ? `https://api.themoviedb.org/3/movie/${item.sadrzaj_id}?api_key=${process.env.TMDB_API_KEY}`
                        : `https://api.themoviedb.org/3/tv/${item.sadrzaj_id}?api_key=${process.env.TMDB_API_KEY}`;

                    const response = await axios.get(apiUrl);
                    return {
                        id: item.sadrzaj_id,
                        tip: item.tip,
                        naziv: response.data.title || response.data.name,
                        poster_path: response.data.poster_path
                    };
                } catch (error) {
                    console.error(`TMDB API error for ID ${item.sadrzaj_id}:`, error);
                    return { id: item.sadrzaj_id, tip: item.tip, naziv: "Unknown", poster_path: null };
                }
            }));
        };

        const [favoritesContent, watchedContent] = await Promise.all([
            fetchContentDetails(favoriti),
            fetchContentDetails(pogledano)
        ]);

        connection.end();
        res.render('popisi', {
            popisi,
            favorites: favoritesContent,
            watched: watchedContent,
            favoritesCount: favoritesContent.length,
            watchedCount: watchedContent.length
        });

    } catch (error) {
        console.error('Error processing lists:', error);
        connection.end();
        res.status(500).send('Error retrieving lists.');
    }
});

function queryDatabase(connection, query, params) {
    return new Promise((resolve, reject) => {
        connection.query(query, params, (err, results) => {
            if (err) return reject(err);
            resolve(results);
        });
    });
}



app.post('/popisi/kreiraj', requireLogin, async (req, res) => {
    const { naziv, tip_popisa } = req.body;
    const userId = req.session.userId;
    const username = req.session.username;

    if (!username) return res.status(401).send('Morate biti prijavljeni.');

    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const sql = 'INSERT INTO popisi (naziv, tip_popisa, korisnik_id, sadrzaj) VALUES (?, ?, ?, ?)';
    connection.query(sql, [naziv, tip_popisa, userId, '[]'], (err) => {
        connection.end();
        if (err) {
            console.error('Greška prilikom stvaranja popisa:', err);
            return res.status(500).send('Pogreška prilikom stvaranja popisa.');
        }
        res.redirect('/popisi');
    });
});

app.post("/popisi/dodaj", requireLogin, async (req, res) => {
    const { popis_id, sadrzaj_id, tip_sadrzaja } = req.body;

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    try {
        connection.query(
            "SELECT sadrzaj FROM popisi WHERE id = ? AND korisnik_id = ?",
            [popis_id, req.session.userId],
            (err, results) => {
                if (err) {
                    console.error("Greška pri dohvaćanju popisa:", err);
                    connection.end();
                    return res.status(500).send("Greška pri dohvaćanju popisa.");
                }

                if (results.length === 0) {
                    connection.end();
                    return res.status(404).send("Popis nije pronađen.");
                }

                let sadrzaj = [];
                if (results[0].sadrzaj && results[0].sadrzaj !== "null") {
                    try {
                        sadrzaj = JSON.parse(results[0].sadrzaj);
                    } catch (parseError) {
                        console.error("Greška pri parsiranju JSON-a:", parseError);
                        sadrzaj = [];
                    }
                }

                const alreadyExists = sadrzaj.some(item => item.id == sadrzaj_id && item.tip === tip_sadrzaja);
                if (alreadyExists) {
                    connection.end();
                    return res.status(400).send("Već se nalazi u popisu.");
                }

                sadrzaj.push({ id: sadrzaj_id, tip: tip_sadrzaja });

                connection.query(
                    "UPDATE popisi SET sadrzaj = ? WHERE id = ?",
                    [JSON.stringify(sadrzaj), popis_id],
                    (updateErr) => {
                        connection.end();
                        if (updateErr) {
                            console.error("Greška pri ažuriranju popisa:", updateErr);
                            return res.status(500).send("Greška prilikom ažuriranja popisa.");
                        }
                        res.redirect("/popisi");
                    }
                );
            }
        );
    } catch (error) {
        console.error("Greška:", error);
        connection.end();
        res.status(500).send("Greška na serveru.");
    }
});

app.post("/popisi/obrisi", requireLogin, (req, res) => {
    const { popis_id } = req.body;

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    connection.query(
        "DELETE FROM popisi WHERE id = ? AND korisnik_id = ?",
        [popis_id, req.session.userId],
        (err) => {
            connection.end();
            if (err) {
                console.error("Greška pri brisanju popisa:", err);
                return res.status(500).send("Greška prilikom brisanja popisa.");
            }
            res.redirect("/popisi");
        }
    );
});

app.get('/popisi/:id', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    const popisId = req.params.id;

    if (popisId === "favorites" || popisId === "watched") {
        const tip = popisId === "favorites" ? "favoriti" : "pogledano";
        const naslov = popisId === "favorites" ? "Favorites" : "Watched";

        const mysql = require('mysql');
        const connection = mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        connection.connect();

        const sql = `SELECT sadrzaj_id, tip FROM ${tip} WHERE korisnik_id = ?`;
        connection.query(sql, [userId], async (err, results) => {
            connection.end();
            if (err) {
                console.error(`Error fetching ${tip}:`, err);
                return res.status(500).send(`Error retrieving ${naslov}.`);
            }

            const sadrzaj = [];
            for (let item of results) {
                try {
                    const apiUrl = item.tip === "film"
                        ? `https://api.themoviedb.org/3/movie/${item.sadrzaj_id}?api_key=${process.env.TMDB_API_KEY}`
                        : `https://api.themoviedb.org/3/tv/${item.sadrzaj_id}?api_key=${process.env.TMDB_API_KEY}`;

                    const response = await axios.get(apiUrl);
                    sadrzaj.push({
                        id: item.sadrzaj_id,
                        tip: item.tip,
                        naziv: response.data.title || response.data.name,
                        poster_path: response.data.poster_path
                    });
                } catch (apiError) {
                    console.error(`TMDB API error (${item.sadrzaj_id}):`, apiError);
                }
            }

            return res.render('popis', { popis: { naziv: naslov, sadrzaj } });
        });
    } else {
        const mysql = require('mysql');
        const connection = mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        connection.connect();

        const sql = 'SELECT * FROM popisi WHERE id = ? AND korisnik_id = ?';
        connection.query(sql, [popisId, userId], async (err, results) => {
            connection.end();
            if (err) {
                console.error('Error fetching list:', err);
                return res.status(500).send('Error retrieving list.');
            }

            if (results.length === 0) {
                return res.status(404).send('List not found.');
            }

            const popis = results[0];
            popis.sadrzaj = popis.sadrzaj ? JSON.parse(popis.sadrzaj) : [];

            for (let item of popis.sadrzaj) {
                const apiUrl = item.tip === "film"
                    ? `https://api.themoviedb.org/3/movie/${item.id}?api_key=${process.env.TMDB_API_KEY}`
                    : `https://api.themoviedb.org/3/tv/${item.id}?api_key=${process.env.TMDB_API_KEY}`;

                try {
                    const response = await axios.get(apiUrl);
                    item.naziv = response.data.title || response.data.name;
                    item.poster_path = response.data.poster_path;
                } catch (apiError) {
                    console.error(`TMDB API error (${item.id}):`, apiError);
                    item.naziv = "Unknown";
                    item.poster_path = null;
                }
            }

            res.render('popis', { popis });
        });
    }
});


app.post("/popisi/obrisi-stavku", requireLogin, async (req, res) => {
    const { popis_id, sadrzaj_id, tip_sadrzaja } = req.body;

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    try {
        connection.query(
            "SELECT sadrzaj FROM popisi WHERE id = ? AND korisnik_id = ?",
            [popis_id, req.session.userId],
            (err, results) => {
                if (err) {
                    console.error("Greška pri dohvaćanju popisa:", err);
                    connection.end();
                    return res.status(500).send("Greška pri dohvaćanju popisa.");
                }

                if (results.length === 0) {
                    connection.end();
                    return res.status(404).send("Popis nije pronađen.");
                }

                let sadrzaj = results[0].sadrzaj ? JSON.parse(results[0].sadrzaj) : [];

                sadrzaj = sadrzaj.filter(item => !(item.id == sadrzaj_id && item.tip === tip_sadrzaja));

                connection.query(
                    "UPDATE popisi SET sadrzaj = ? WHERE id = ?",
                    [JSON.stringify(sadrzaj), popis_id],
                    (updateErr) => {
                        connection.end();
                        if (updateErr) {
                            console.error("Greška pri ažuriranju popisa:", updateErr);
                            return res.status(500).send("Greška prilikom ažuriranja popisa.");
                        }
                        res.redirect("/popisi");
                    }
                );
            }
        );
    } catch (error) {
        console.error("Greška:", error);
        connection.end();
        res.status(500).send("Greška na serveru.");
    }
});

app.get('/api/popisi', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).send('Morate biti prijavljeni.');

    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const { tip_popisa } = req.query;

    let sql = 'SELECT id, naziv, tip_popisa FROM popisi WHERE korisnik_id = ?';
    const params = [userId];

    if (tip_popisa) {
        sql += ' AND (tip_popisa = ? OR tip_popisa = "mixed")';
        params.push(tip_popisa);
    }

    connection.query(sql, params, (err, results) => {
        connection.end();
        if (err) {
            console.error('Greška prilikom dohvaćanja popisa:', err);
            return res.status(500).send('Pogreška prilikom dohvaćanja popisa.');
        }
        res.json(results);
    });
});


app.post('/favoriti/dodaj', requireLogin, (req, res) => {
    const { sadrzaj_id, tip } = req.body;
    const userId = req.session.userId;

    if (!sadrzaj_id || !tip) return res.status(400).send("Invalid data.");

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    connection.query(
        "SELECT * FROM favoriti WHERE korisnik_id = ? AND sadrzaj_id = ? AND tip = ?",
        [userId, sadrzaj_id, tip],
        (err, results) => {
            if (err) {
                connection.end();
                return res.status(500).send("Database error.");
            }
            if (results.length > 0) {
                connection.end();
                return res.status(409).send("Already in Favorites.");
            }

            connection.query(
                "INSERT INTO favoriti (korisnik_id, sadrzaj_id, tip) VALUES (?, ?, ?)",
                [userId, sadrzaj_id, tip],
                (insertErr) => {
                    connection.end();
                    if (insertErr) return res.status(500).send("Database error.");
                    res.sendStatus(200);
                }
            );
        }
    );
});

app.post('/favoriti/ukloni', requireLogin, (req, res) => {
    const { sadrzaj_id, tip } = req.body;
    const userId = req.session.userId;

    if (!sadrzaj_id || !tip) return res.status(400).send("Invalid data.");

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    connection.query(
        "DELETE FROM favoriti WHERE korisnik_id = ? AND sadrzaj_id = ? AND tip = ?",
        [userId, sadrzaj_id, tip],
        (err) => {
            connection.end();
            if (err) return res.status(500).send("Database error.");
            res.sendStatus(200);
        }
    );
});

app.post('/pogledano/dodaj', requireLogin, (req, res) => {
    const { sadrzaj_id, tip } = req.body;
    const userId = req.session.userId;

    if (!sadrzaj_id || !tip) return res.status(400).send("Invalid data.");

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    connection.query(
        "SELECT * FROM pogledano WHERE korisnik_id = ? AND sadrzaj_id = ? AND tip = ?",
        [userId, sadrzaj_id, tip],
        (err, results) => {
            if (err) {
                connection.end();
                return res.status(500).send("Database error.");
            }
            if (results.length > 0) {
                connection.end();
                return res.status(409).send("Already marked as Watched.");
            }

            connection.query(
                "INSERT INTO pogledano (korisnik_id, sadrzaj_id, tip) VALUES (?, ?, ?)",
                [userId, sadrzaj_id, tip],
                (insertErr) => {
                    connection.end();
                    if (insertErr) return res.status(500).send("Database error.");
                    res.sendStatus(200);
                }
            );
        }
    );
});

app.post('/pogledano/ukloni', requireLogin, (req, res) => {
    const { sadrzaj_id, tip } = req.body;
    const userId = req.session.userId;

    if (!sadrzaj_id || !tip) return res.status(400).send("Invalid data.");

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    connection.query(
        "DELETE FROM pogledano WHERE korisnik_id = ? AND sadrzaj_id = ? AND tip = ?",
        [userId, sadrzaj_id, tip],
        (err) => {
            connection.end();
            if (err) return res.status(500).send("Database error.");
            res.sendStatus(200);
        }
    );
});


app.get('/film/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const filmId = req.params.id;
    const userId = req.session.userId;

    const filmUrl = `https://api.themoviedb.org/3/movie/${filmId}?api_key=${apiKey}&append_to_response=credits,videos,releases`;
    const recommendationsUrl = `https://api.themoviedb.org/3/movie/${filmId}/recommendations?api_key=${apiKey}`;
    const watchProvidersUrl = `https://api.themoviedb.org/3/movie/${filmId}/watch/providers?api_key=${apiKey}`;

    try {
        const [filmResponse, recommendationsResponse, watchProvidersResponse] = await Promise.all([
            axios.get(filmUrl),
            axios.get(recommendationsUrl),
            axios.get(watchProvidersUrl)
        ]);

        const film = filmResponse.data;
        const preporuke = recommendationsResponse.data.results.slice(0, 7);
        const watchProviders = watchProvidersResponse.data.results || {};

        let userLanguage = req.headers["accept-language"]?.split(",")[0]?.split("-")[0] || "en";

        let userCountry = req.headers["accept-language"]?.match(/-[A-Z]{2}/)?.[0]?.replace("-", "") || "US";
        if (!watchProviders[userCountry]) {
            userCountry = watchProviders["US"] ? "US" : Object.keys(watchProviders)[0] || "US";
        }

        const countryMapping = {
            "en": "US",
            "hr": "HR",
            "de": "DE",
            "fr": "FR",
            "es": "ES",
            "it": "IT"
        };
        userCountry = countryMapping[userLanguage] || userCountry;

        const filteredProviders = {
            country: userCountry,
            providers: watchProviders[userCountry]?.flatrate || [],
            link: watchProviders[userCountry]?.link || null
        };

        const director = film.credits.crew.find(person => person.job === 'Director');
        const releaseInfo = film.releases.countries.find(country => country.iso_3166_1 === 'US');
        const pgRating = releaseInfo?.certification || 'N/A';

        const mysql = require('mysql');
        const connection = mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        connection.connect();

        let isFavorite = false;
        let isWatched = false;

        const favoriteQuery = "SELECT * FROM favoriti WHERE korisnik_id = ? AND sadrzaj_id = ? AND tip = 'film'";
        const watchedQuery = "SELECT * FROM pogledano WHERE korisnik_id = ? AND sadrzaj_id = ? AND tip = 'film'";

        connection.query(favoriteQuery, [userId, filmId], (err, favoriteResults) => {
            if (favoriteResults.length > 0) isFavorite = true;

            connection.query(watchedQuery, [userId, filmId], (err, watchedResults) => {
                if (watchedResults.length > 0) isWatched = true;

                connection.query(
                    `SELECT k.tekst, k.ocjena, k.datum, k.korisnik_id, korisnici.nadimak 
                    FROM komentari k 
                    LEFT JOIN korisnici ON k.korisnik_id = korisnici.id
                    WHERE k.film_id = ? 
                    ORDER BY k.datum DESC
                    LIMIT 3`,
                    [filmId],
                    (error, results) => {
                        if (error) {
                            console.error('Greška prilikom dohvaćanja komentara:', error);
                            return res.status(500).send('Greška prilikom dohvaćanja komentara.');
                        }

                        connection.query(
                            `SELECT COUNT(*) AS total FROM komentari WHERE film_id = ?`,
                            [filmId],
                            (countError, countResults) => {
                                if (countError) {
                                    console.error('Greška prilikom prebrojavanja komentara:', countError);
                                    return res.status(500).send('Greška prilikom prebrojavanja komentara.');
                                }

                                const totalComments = countResults[0].total;
                                const userScores = results.map(row => row.ocjena);
                                const userScore = userScores.length > 0 
                                    ? (userScores.reduce((a, b) => a + b, 0) / userScores.length).toFixed(1) 
                                    : '0';

                                const userScoreColor = getScoreColor(userScore);
                                const tmdbScoreColor = getScoreColor(film.vote_average);

                                connection.end();
                                res.render('film', {
                                    film,
                                    direktor: director ? director.name : 'N/A',
                                    tmdbRating: film.vote_average.toFixed(1),
                                    userScore,
                                    pgRating,
                                    komentari: results,
                                    ukupnoKomentara: totalComments,
                                    preporuke,
                                    userScoreColor,
                                    tmdbScoreColor,
                                    filmId,
                                    watchProviders: filteredProviders,
                                    userLanguage: userCountry,
                                    isFavorite,
                                    isWatched,
                                    csrfToken: req.csrfToken()
                                });
                            }
                        );
                    }
                );
            });
        });

    } catch (error) {
        console.error('Došlo je do pogreške prilikom dohvaćanja podataka o filmu:', error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka o filmu.');
    }
});


app.get('/film/:id/glumci', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const filmId = req.params.id;

    const filmUrl = `https://api.themoviedb.org/3/movie/${filmId}?api_key=${apiKey}`;
    const creditsUrl = `https://api.themoviedb.org/3/movie/${filmId}/credits?api_key=${apiKey}`;
    try {
        const [creditsResponse, filmResponse] = await Promise.all([
            axios.get(creditsUrl),
            axios.get(filmUrl)
        ]);

        const credits = creditsResponse.data;
        const film = filmResponse.data;

        const crewByDepartment = credits.crew.reduce((acc, crewMember) => {
            if (!acc[crewMember.department]) {
                acc[crewMember.department] = [];
            }
            acc[crewMember.department].push(crewMember);
            return acc;
        }, {});

        res.render('film_glumci', {
            cast: credits.cast || [],
            crewByDepartment,
            mediaType: 'movie',
            filmTitle: film.title || 'N/A',
            releaseYear: film.release_date?.substr(0, 4) || 'N/A',
            mediaId: filmId
        });
    } catch (error) {
        console.error('Error fetching movie credits:', error);
        res.status(500).send('An error occurred while fetching movie credits.');
    }
});

app.get('/film/:id/detalji', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const filmId = req.params.id;
    const watchProvidersUrl = `https://api.themoviedb.org/3/movie/${filmId}/watch/providers?api_key=${apiKey}`;
    const watchProvidersResponse = await axios.get(watchProvidersUrl);
    const watchProviders = watchProvidersResponse.data.results || {};

    const detailedProviders = {};
    ['US', 'HR', 'GB', 'CA', 'DE', 'IT', 'FR', 'ES'].forEach(country => {
        if (watchProviders[country]) {
            detailedProviders[country] = watchProviders[country].flatrate || [];
        }
    });

    try {
        const filmResponse = await axios.get(`https://api.themoviedb.org/3/movie/${filmId}?api_key=${apiKey}&append_to_response=credits`);
        const film = filmResponse.data;

        res.render('detalji_film', {
            film,
            userScore: film.vote_average.toFixed(1),
            userScoreColor: getScoreColor(film.vote_average),
            watchProviders: detailedProviders,
        });
    } catch (error) {
        console.error("Error fetching movie details:", error);
        res.status(500).send("Error loading details.");
    }
});


app.get('/serija/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const serijaId = req.params.id;
    const userId = req.session.userId;

    const serijaUrl = `https://api.themoviedb.org/3/tv/${serijaId}?api_key=${apiKey}&append_to_response=videos,credits,recommendations`;
    const watchProvidersUrl = `https://api.themoviedb.org/3/tv/${serijaId}/watch/providers?api_key=${apiKey}`;

    try {
        const [serijaResponse, watchProvidersResponse] = await Promise.all([
            axios.get(serijaUrl),
            axios.get(watchProvidersUrl)
        ]);

        const serija = serijaResponse.data;
        const preporuke = serija.recommendations?.results?.slice(0, 7) || [];
        const watchProviders = watchProvidersResponse.data.results || {};

        let userLanguage = req.headers["accept-language"]?.split(",")[0]?.split("-")[0] || "en";

        let userCountry = req.headers["accept-language"]?.match(/-[A-Z]{2}/)?.[0]?.replace("-", "") || "US";
        if (!watchProviders[userCountry]) {
            userCountry = watchProviders["US"] ? "US" : Object.keys(watchProviders)[0] || "US";
        }

        const countryMapping = {
            "en": "US",
            "hr": "HR",
            "de": "DE",
            "fr": "FR",
            "es": "ES",
            "it": "IT"
        };
        userCountry = countryMapping[userLanguage] || userCountry;

        const filteredProviders = {
            country: userCountry,
            providers: watchProviders[userCountry]?.flatrate || [],
            link: watchProviders[userCountry]?.link || null
        };

        const creator = serija.created_by.length > 0 ? serija.created_by[0].name : 'N/A';

        const mysql = require('mysql');
        const connection = mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        connection.connect();

        let isFavorite = false;
        let isWatched = false;

        const favoriteQuery = "SELECT * FROM favoriti WHERE korisnik_id = ? AND sadrzaj_id = ? AND tip = 'serija'";
        const watchedQuery = "SELECT * FROM pogledano WHERE korisnik_id = ? AND sadrzaj_id = ? AND tip = 'serija'";

        connection.query(favoriteQuery, [userId, serijaId], (err, favoriteResults) => {
            if (favoriteResults.length > 0) isFavorite = true;

            connection.query(watchedQuery, [userId, serijaId], (err, watchedResults) => {
                if (watchedResults.length > 0) isWatched = true;

                connection.query(
                    `SELECT k.tekst, k.ocjena, k.datum, k.korisnik_id, korisnici.nadimak 
                    FROM komentari k 
                    LEFT JOIN korisnici ON k.korisnik_id = korisnici.id
                    WHERE k.serija_id = ? 
                    ORDER BY k.datum DESC 
                    LIMIT 3`,
                    [serijaId],
                    (error, results) => {
                        if (error) {
                            console.error('Greška prilikom dohvaćanja komentara za seriju:', error);
                            connection.end();
                            return res.status(500).send('Greška prilikom dohvaćanja komentara za seriju.');
                        }

                        connection.query(
                            `SELECT COUNT(*) AS total FROM komentari WHERE serija_id = ?`,
                            [serijaId],
                            (countError, countResults) => {
                                connection.end();

                                if (countError) {
                                    console.error('Greška prilikom prebrojavanja komentara:', countError);
                                    return res.status(500).send('Greška prilikom prebrojavanja komentara.');
                                }

                                const totalComments = countResults[0].total;
                                const userScores = results.map(row => row.ocjena);
                                const userScore = userScores.length > 0 
                                    ? (userScores.reduce((a, b) => a + b, 0) / userScores.length).toFixed(1) 
                                    : '0';

                                const userScoreColor = getScoreColor(userScore);
                                const tmdbScoreColor = getScoreColor(serija.vote_average);

                                res.render('serija', {
                                    serija,
                                    creator,
                                    seasons: serija.seasons,
                                    tmdbRating: serija.vote_average.toFixed(1),
                                    userScore,
                                    komentari: results,
                                    ukupnoKomentara: totalComments,
                                    preporuke,
                                    userScoreColor,
                                    tmdbScoreColor,
                                    serijaId,
                                    watchProviders: filteredProviders,
                                    userLanguage: userCountry,
                                    isFavorite,
                                    isWatched,
                                    csrfToken: req.csrfToken()
                                });
                            }
                        );
                    }
                );
            });
        });

    } catch (error) {
        console.error('Došlo je do pogreške prilikom dohvaćanja podataka o seriji:', error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka o seriji.');
    }
});

app.get('/serija/:id/glumci', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const serijaId = req.params.id;

    const url = `https://api.themoviedb.org/3/tv/${serijaId}`;
    const creditsUrl = `${url}/aggregate_credits?api_key=${apiKey}`;
    try {
        const [creditsResponse, seriesResponse] = await Promise.all([
            axios.get(creditsUrl),
            axios.get(`${url}?api_key=${apiKey}`)
        ]);

        const credits = creditsResponse.data;
        const series = seriesResponse.data;

        const crewByDepartment = credits.crew.reduce((acc, crewMember) => {
            if (!acc[crewMember.department]) {
                acc[crewMember.department] = [];
            }
            acc[crewMember.department].push(crewMember);
            return acc;
        }, {});

        res.render('film_glumci', {
            cast: credits.cast,
            crewByDepartment,
            mediaType: 'tv',
            filmTitle: series.name,
            releaseYear: series.first_air_date?.substr(0, 4),
            mediaId: serijaId
        });
    } catch (error) {
        console.error('Error fetching TV series credits:', error);
        res.status(500).send('An error occurred while fetching cast and crew data for the TV series.');
    }
});

app.get('/serija/:id/detalji', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const serijaId = req.params.id;
    const watchProvidersUrl = `https://api.themoviedb.org/3/tv/${serijaId}/watch/providers?api_key=${apiKey}`;

    try {
        const serijaResponse = await axios.get(`https://api.themoviedb.org/3/tv/${serijaId}?api_key=${apiKey}&append_to_response=credits`);
        const serija = serijaResponse.data;

        const watchProvidersResponse = await axios.get(watchProvidersUrl);
        const watchProviders = watchProvidersResponse.data.results || {};

        const detailedProviders = {};
        ['US', 'HR', 'GB', 'CA', 'DE', 'IT', 'FR', 'ES'].forEach(country => {
            if (watchProviders[country]) {
                detailedProviders[country] = watchProviders[country].flatrate || [];
            }
        });

        res.render('detalji_serija', {
            serija,
            userScore: serija.vote_average.toFixed(1),
            userScoreColor: getScoreColor(serija.vote_average),
            watchProviders: detailedProviders,
        });
    } catch (error) {
        console.error("Error fetching series details:", error);
        res.status(500).send("Error loading details.");
    }
});


app.get('/serija/:id/seasons', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const serijaId = req.params.id;

    const url = `https://api.themoviedb.org/3/tv/${serijaId}?api_key=${apiKey}`;
    try {
        const response = await axios.get(url);
        const serija = response.data;

        serija.seasons = serija.seasons.filter(season => season.air_date && season.episode_count > 0);

        res.render('serija_sezone', {
            serija,
            firstSeasonYear: serija.seasons[0]?.air_date?.substr(0, 4)
        });
    } catch (error) {
        console.error('Error fetching series seasons:', error);
        res.status(500).send('An error occurred while fetching series seasons.');
    }
});

app.get('/serija/:id/season/:seasonNumber', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const seriesId = req.params.id;
    const seasonNumber = req.params.seasonNumber;

    const seasonUrl = `https://api.themoviedb.org/3/tv/${seriesId}/season/${seasonNumber}?api_key=${apiKey}`;
    const seriesUrl = `https://api.themoviedb.org/3/tv/${seriesId}?api_key=${apiKey}`;

    try {
        const [seasonResponse, seriesResponse] = await Promise.all([
            axios.get(seasonUrl),
            axios.get(seriesUrl),
        ]);

        const season = seasonResponse.data;
        const serija = seriesResponse.data;

        globalSeasonCache[season.id] = season;

        res.render('sezona', {
            serija,
            season,
        });
    } catch (error) {
        console.error('Error fetching season data:', error);
        res.status(500).send('An error occurred while fetching season data.');
    }
});

app.get('/api/episode/:seriesId/season/:seasonNumber/episode/:episodeNumber', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const { seriesId, seasonNumber, episodeNumber } = req.params;

    const episodeCreditsUrl = `https://api.themoviedb.org/3/tv/${seriesId}/season/${seasonNumber}/episode/${episodeNumber}/credits?api_key=${apiKey}`;

    try {
        const creditsResponse = await axios.get(episodeCreditsUrl);
        const credits = creditsResponse.data;

        res.json({ guest_stars: credits.guest_stars });
    } catch (error) {
        console.error('Error fetching episode credits:', error);
        res.status(500).json({ error: 'Failed to fetch episode credits.' });
    }
});

app.get('/serija/:serijaId/sezona/:sezonaId/epizoda/:epizodaId/cast', async (req, res) => {
    const { serijaId, sezonaId, epizodaId } = req.params;

    try {
        const [episode, serija, season] = await Promise.all([
            getEpisodeDetails(serijaId, sezonaId, epizodaId),
            getSeriesDetails(serijaId),
            getSeasonDetails(serijaId, sezonaId)
        ]);

        res.render('epizoda_glumci', {
            serija,
            episode,
            season,
            seasonYear: season.air_date?.substr(0, 4)
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error fetching episode cast details');
    }
});

app.get('/komentar/:tip/:id', requireLogin, async (req, res) => {
    const { tip, id } = req.params;
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.redirect(`/login?redirect=/komentar/${tip}/${id}`);
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const komentarQuery = `
        SELECT tekst, ocjena 
        FROM komentari 
        WHERE korisnik_id = ? AND ${tip === 'film' ? 'film_id' : 'serija_id'} = ?
    `;

    const apiUrl = tip === 'film'
        ? `https://api.themoviedb.org/3/movie/${id}?api_key=${process.env.TMDB_API_KEY}`
        : `https://api.themoviedb.org/3/tv/${id}?api_key=${process.env.TMDB_API_KEY}`;

    try {
        const komentarPromise = new Promise((resolve, reject) => {
            connection.query(komentarQuery, [korisnikId, id], (error, results) => {
                if (error) return reject(error);
                resolve(results[0] || null);
            });
        });

        const mediaPromise = axios.get(apiUrl);

        const [komentar, mediaResponse] = await Promise.all([komentarPromise, mediaPromise]);
        const mediaData = mediaResponse.data;

        const naslov = tip === 'film' ? mediaData.title : mediaData.name;
        const godina = (mediaData.release_date || mediaData.first_air_date || '').substr(0, 4);

        res.render('dodaj_izmijeni_komentar', {
            komentar,
            isEdit: !!komentar,
            actionUrl: komentar ? '/uredi-komentar' : '/dodaj-komentar',
            filmId: tip === 'film' ? id : null,
            serijaId: tip === 'serija' ? id : null,
            naslov,
            godina,
            tip,
        });

    } catch (error) {
        console.error('Error fetching comment or media details:', error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    } finally {
        connection.end();
    }
});

function containsInvalidCharacters(text) {
    return text !== sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
}

app.post('/dodaj-komentar', requireLogin, (req, res) => {
    const { tekst, ocjena, filmId, serijaId } = req.body;
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.status(401).json({ error: "You must be logged in to post a review." });
    }

    const cleanedText = tekst
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{2,}/g, '\n\n')
        .trimEnd();

    if (!cleanedText.replace(/\s+/g, '')) {
        return res.status(400).json({ error: "Review cannot be empty." });
    }

    if (containsInvalidCharacters(cleanedText)) {
        return res.status(400).json({ error: "Review cannot contain invalid characters." });
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const query = `
        INSERT INTO komentari (tekst, ocjena, datum, korisnik_id, film_id, serija_id)
        VALUES (?, ?, NOW(), ?, ?, ?)
    `;

    connection.query(query, [cleanedText, ocjena, korisnikId, filmId || null, serijaId || null], (error) => {
        connection.end();
        if (error) {
            return res.status(500).json({ error: "Error adding the comment." });
        }
        res.redirect(filmId ? `/film/${filmId}` : `/serija/${serijaId}`);
    });
});

app.post('/uredi-komentar', requireLogin, (req, res) => {
    const { tekst, ocjena, filmId, serijaId } = req.body;
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.status(401).json({ error: "You must be logged in to edit a review." });
    }

    const cleanedText = tekst
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{2,}/g, '\n\n')
        .trimEnd();

    if (!cleanedText.replace(/\s+/g, '')) {
        return res.status(400).json({ error: "Review cannot be empty." });
    }

    if (containsInvalidCharacters(cleanedText)) {
        return res.status(400).json({ error: "Review cannot contain invalid characters." });
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const query = `
        UPDATE komentari 
        SET tekst = ?, ocjena = ?, datum = NOW()
        WHERE korisnik_id = ? AND (film_id = ? OR serija_id = ?)
    `;

    connection.query(query, [cleanedText, ocjena, korisnikId, filmId || null, serijaId || null], (error) => {
        connection.end();
        if (error) {
            return res.status(500).json({ error: "Error updating the comment." });
        }
        res.redirect(filmId ? `/film/${filmId}` : `/serija/${serijaId}`);
    });
});

app.post('/izbrisi-komentar', requireLogin, (req, res) => {
    const { filmId, serijaId } = req.body;
    const korisnikId = req.session.userId;

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const query = `
        DELETE FROM komentari 
        WHERE korisnik_id = ? AND (film_id = ? OR serija_id = ?)
    `;

    connection.query(query, [korisnikId, filmId || null, serijaId || null], (error) => {
        if (error) {
            console.error('Error deleting comment:', error);
            return res.status(500).send('Error deleting the comment.');
        }
        res.redirect(filmId ? `/film/${filmId}` : `/serija/${serijaId}`);
    });
});

app.get('/komentari/:tip/:id', (req, res) => {
    const { tip, id } = req.params;
    const column = tip === 'film' ? 'film_id' : 'serija_id';

    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const query = `
        SELECT k.tekst, k.ocjena, k.datum, 
            COALESCE(korisnici.nadimak, 'Guest') AS nadimak
        FROM komentari k 
        LEFT JOIN korisnici ON k.korisnik_id = korisnici.id
        WHERE k.${column} = ?
        ORDER BY k.datum DESC
        LIMIT 3

    `;

    connection.query(query, [id], (error, results) => {
        if (error) {
            console.error('Error fetching comments:', error);
            return res.status(500).send('Error fetching comments.');
        }
        res.json(results);
    });

    connection.end();
});

app.get('/svi-komentari/:tip/:id', async (req, res) => {
    const { tip, id } = req.params;
    const column = tip === 'film' ? 'film_id' : 'serija_id';
    const apiKey = process.env.TMDB_API_KEY;

    const mediaUrl = tip === 'film'
        ? `https://api.themoviedb.org/3/movie/${id}?api_key=${apiKey}`
        : `https://api.themoviedb.org/3/tv/${id}?api_key=${apiKey}`;

    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const komentariQuery = `
        SELECT k.tekst, k.ocjena, k.datum, korisnici.nadimak
        FROM komentari k
        LEFT JOIN korisnici ON k.korisnik_id = korisnici.id
        WHERE k.${column} = ?
        ORDER BY k.datum DESC
    `;

    try {
        const komentariPromise = new Promise((resolve, reject) => {
            connection.query(komentariQuery, [id], (error, results) => {
                if (error) return reject(error);
                resolve(results);
            });
        });

        const mediaPromise = axios.get(mediaUrl);

        const [komentari, mediaResponse] = await Promise.all([komentariPromise, mediaPromise]);
        const mediaData = mediaResponse.data;

        const filmTitle = tip === 'film' ? mediaData.title : mediaData.name;
        const releaseYear = (mediaData.release_date || mediaData.first_air_date || '').substr(0, 4);

        res.render('svi_komentari', {
            komentari,
            filmTitle: filmTitle || 'Title unavailable',
            releaseYear: releaseYear || 'N/A',
            mediaType: tip === 'film' ? 'movie' : 'series',
            mediaId: id,
        });
    } catch (error) {
        console.error('Greška prilikom dohvaćanja komentara ili podataka o mediju:', error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    } finally {
        connection.end();
    }
});


app.get('/osoba/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const osobaId = req.params.id;

    const url = `https://api.themoviedb.org/3/person/${osobaId}?api_key=${apiKey}&append_to_response=movie_credits,tv_credits,combined_credits,external_ids`;

    try {
        const response = await axios.get(url);
        const osoba = response.data;

        const combinedCredits = osoba.combined_credits?.cast || [];

        const knownFor = combinedCredits
            .filter(project => project.poster_path)
            .sort((a, b) => {
                const aOrder = a.order ?? Number.MAX_VALUE;
                const bOrder = b.order ?? Number.MAX_VALUE;

                if (aOrder !== bOrder) {
                    return aOrder - bOrder;
                }

                return b.popularity - a.popularity;
            })
            .slice(0, 6);

        osoba.known_for = knownFor;

        res.render('osoba', { osoba });
    } catch (error) {
        console.error('Error fetching person data:', error);
        res.status(500).send('An error occurred while fetching person data.');
    }
});

app.get('/people', async (req, res) => {
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/person/popular?api_key=${process.env.TMDB_API_KEY}`);
        res.render('osobe', { people: response.data.results });
    } catch (error) {
        console.error("Error fetching popular people:", error);
        res.render('osobe', { people: [] });
    }
});

app.listen(port, () => {
    console.log(`Server pokrenut na http://localhost:${port}`);
});
