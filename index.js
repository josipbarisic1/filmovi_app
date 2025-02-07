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
    cookie: { secure: false }, // HTTPS - true
}));
app.use((req, res, next) => {
    res.locals.session = req.session || {};
    res.locals.currentUrl = req.originalUrl;
    next();
});

/*
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            imgSrc: ["'self'", "https://image.tmdb.org", "https://www.themoviedb.org", "https://assets.tmdb.org"],
            mediaSrc: ["'self'", "https://www.youtube.com", "https://i.ytimg.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://www.youtube.com", "https://www.gstatic.com"],
            frameSrc: ["'self'", "https://www.youtube.com"],
            connectSrc: ["'self'", "https://api.themoviedb.org"]
        }
    }
})); */

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

app.get('/ai', (req, res) => {
    res.render('ai', { csrfToken: req.csrfToken() });
});

app.post('/ai-recommend', async (req, res) => {
    const { userMessage } = req.body;

    if (!userMessage) {
        return res.status(400).json({ error: "Message is required." });
    }

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are a movie/TV show recommendation AI. Suggest movies or TV shows based on user preferences." },
                { role: "user", content: userMessage }
            ],
            max_tokens: 100,
            temperature: 0.7
        });

        const aiResponse = completion.choices[0].message.content;
        res.json({ recommendation: aiResponse });
    } catch (error) {
        console.error("Error with AI:", error);
        res.status(500).json({ error: "AI recommendation failed." });
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

app.get('/', (req, res) => {
    const naziv = req.query.naziv || '';
    const category = req.query.category || 'movie';

    res.render('pocetna', { 
        title: 'Filmovi Popis',
        naziv: naziv,
        category: category
    });
});


app.get('/test', (req, res) => {
    res.render('partials/header', { session: req.session });
});


app.post('/register', async (req, res) => {
    const { username, email_address, age, phone_number, gender, password, nadimak } = req.body;

    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        connection.query(
            `INSERT INTO korisnici (username, email_address, age, phone_number, gender, password, nadimak, role, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'user', NOW())`,
            [username, email_address, age, phone_number, gender, hashedPassword, nadimak || null],
            (error, results) => {
                connection.end();
                if (error) {
                    console.error('Greška prilikom registracije korisnika:', error);
                    return res.status(500).send('Došlo je do greške prilikom registracije.');
                }
                res.redirect('/login');
            }
        );
    } catch (err) {
        console.error('Greška prilikom hashiranja lozinke:', err);
        res.status(500).send('Greška na serveru.');
    }
});



app.get('/register', (req, res) => {
    res.render('register', { session: req.session });
});

app.get('/login', (req, res) => {
    const redirect = req.query.redirect || req.headers.referer || '/';
    res.render('login', { session: req.session, redirect });
});
app.post('/login', async (req, res) => {
    const { username, password, redirect } = req.body;

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

app.get('/profil', (req, res) => {
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

        res.render('profil', {
            korisnik: results[0]
        });
    });
});

app.get('/profile/edit', (req, res) => {
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
            isEdit: true
        });
    });
});

app.post('/profile/update', (req, res) => {
    const { username, email_address, age, phone_number, gender, nadimak } = req.body;
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.status(401).send('Unauthorized');
    }

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

    connection.query(query, [username, email_address, age, phone_number, gender, nadimak, korisnikId], (error) => {
        connection.end();
        if (error) {
            console.error('Error updating profile:', error);
            return res.status(500).send('Error updating profile.');
        }
        res.redirect('/profil');
    });
});


app.get('/profile/lists', (req, res) => {
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

    const query = `SELECT id, naziv, tip_popisa FROM popisi WHERE korisnik_id = ?`;

    connection.query(query, [korisnikId], (error, results) => {
        connection.end();
        if (error) {
            console.error("Error fetching lists:", error);
            return res.status(500).json({ error: "Error fetching lists." });
        }
        res.json(results);
    });
});

app.get('/profile/reviews', (req, res) => {
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


app.get('/pretrazi', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const naziv = req.query.naziv || '';
    const category = req.query.category || 'movie';
    const page = req.query.page || 1;
    const genre = req.query.genre || '';
    const year = req.query.year || '';
    const language = req.query.language || '';
    const sort = req.query.sort || 'alphabetical';

    let url = `https://api.themoviedb.org/3/search/${category}?api_key=${apiKey}&query=${naziv}&page=${page}`;

    if (genre) {
        url += `&with_genres=${genre}`;
    }
    if (year) {
        url += `&year=${year}`;
    }
    if (language) {
        url += `&language=${language}`;
    }

    switch (sort) {
        case 'alphabetical':
            url += '&sort_by=original_title.asc'; 
            break;
        case 'latest':
            url += '&sort_by=release_date.desc'; 
            break;
        case 'most_viewed':
            url += '&sort_by=popularity.desc'; 
            break;
        case 'top_rated':
            url += '&sort_by=vote_average.desc'; 
            break;
        default:
            url += '&sort_by=original_title.asc';
    }

    //console.log(url);
    try {
        const response = await axios.get(url);
        //console.log(response.data);

        const data = response.data;

        const totalPages = data.total_pages;
        const pagination = generatePagination(page, totalPages);

        const genreResponse = await axios.get(`https://api.themoviedb.org/3/genre/movie/list?api_key=${apiKey}`);
        const genres = genreResponse.data.genres;

        res.render('pretrazi_film', {
            data,
            naziv,
            category,
            pagination,
            page,
            totalPages,
            genres,
            selectedGenre: genre,
            selectedYear: year,
            language,
            sort
        });
    } catch (error) {
        //console.error(error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
});


app.post('/pretrazi', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const naziv = req.body.naziv || '';
    const category = req.body.category || 'movie';
    const page = req.query.page || 1;
    const genre = req.body.genre || '';
    const year = req.body.year || '';
    const language = req.body.language || '';
    const sort = req.body.sort || 'alphabetical';

    let url = `https://api.themoviedb.org/3/search/${category}?api_key=${apiKey}&query=${naziv}&page=${page}`;

    if (genre) {
        url += `&with_genres=${genre}`;
    }
    if (year) {
        url += `&year=${year}`;
    }
    if (language) {
        url += `&language=${language}`;
    }

    switch (sort) {
        case 'alphabetical':
            url += '&sort_by=original_title.asc';
            break;
        case 'latest':
            url += '&sort_by=release_date.desc';
            break;
        case 'most_viewed':
            url += '&sort_by=popularity.desc';
            break;
        case 'top_rated':
            url += '&sort_by=vote_average.desc';
            break;
        default:
            url += '&sort_by=original_title.asc';
    }

    try {
        const response = await axios.get(url);
        const data = response.data;

        const totalPages = data.total_pages;
        const pagination = generatePagination(page, totalPages);

        const genreResponse = await axios.get(`https://api.themoviedb.org/3/genre/movie/list?api_key=${apiKey}`);
        const genres = genreResponse.data.genres;

        res.render('pretrazi_film', {
            data,
            naziv,
            category,
            pagination,
            page,
            totalPages,
            genres,
            selectedGenre: genre,
            selectedYear: year,
            language,
            sort
        });
    } catch (error) {
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
});

// Funkcija za generiranje paginacije
/* 
function generatePagination(currentPage, totalPages) {
    let pagination = [];

    if (totalPages <= 5) {
        for (let i = 1; i <= totalPages; i++) {
            pagination.push(i);
        }
    } else {
        if (currentPage <= 3) {
            pagination = [1, 2, 3, 4, 5, '...', totalPages];
        } else if (currentPage >= totalPages - 2) {
            pagination = [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
        } else {
            pagination = [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
        }
    }

    return pagination;
}*/

const generateUrl = (base, sort) => {
    let sortBy = '';
    switch (sort) {
        case 'alphabetical':
            sortBy = 'original_title.asc';
            break;
        case 'latest':
            sortBy = 'release_date.desc';
            break;
        case 'most-viewed':
            sortBy = 'popularity.desc';
            break;
        case 'top-rated':
            sortBy = 'vote_average.desc';
            break;
        default:
            sortBy = 'original_title.asc';
    }
    return `${base}&sort_by=${sortBy}`;
};

const generatePagination = (currentPage, totalPages) => {
    const delta = 2;
    const range = [];
    const rangeWithDots = [];
    let l;

    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
            range.push(i);
        }
    }

    for (let i of range) {
        if (l) {
            if (i - l === 2) {
                rangeWithDots.push(l + 1);
            } else if (i - l !== 1) {
                rangeWithDots.push('...');
            }
        }
        rangeWithDots.push(i);
        l = i;
    }
    return rangeWithDots;
};

const updateRenderParams = async (url, category, sort, req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const page = parseInt(req.query.page) || 1;

    try {
        const response = await axios.get(`${url}&page=${page}`);
        const genreResponse = await axios.get(`https://api.themoviedb.org/3/genre/${category}/list?api_key=${apiKey}`);
        
        const data = response.data;
        const totalPages = data.total_pages;

        const filteredResults = data.results.filter(item => {
            const releaseDate = item.release_date || item.first_air_date;
            return releaseDate && new Date(releaseDate) <= new Date();
        });

        data.results = filteredResults;

        const pagination = generatePagination(page, totalPages);

        res.render('pretrazi_film', {
            data,
            naziv: '',
            category,
            genres: genreResponse.data.genres,
            pagination,
            page,
            totalPages,
            selectedGenre: '',
            selectedYear: '',
            language: '',
            sort,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
};

app.get('/:category/latest', async (req, res) => {
    const category = req.params.category;
    const apiKey = process.env.TMDB_API_KEY;
    const page = parseInt(req.query.page) || 1;

    let url;
    if (category === 'movie') {
        url = `https://api.themoviedb.org/3/movie/now_playing?api_key=${apiKey}&page=${page}`;
    } else if (category === 'tv') {
        url = `https://api.themoviedb.org/3/tv/airing_today?api_key=${apiKey}&page=${page}`;
    } else {
        return res.status(400).send('Nevažeća kategorija.');
    }

    await updateRenderParams(url, category, 'latest', req, res);
});

app.get('/movie/alphabetical', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&sort_by=original_title.asc`;
    await updateRenderParams(url, 'movie', 'alphabetical', req, res);
});


app.get('/movie/most-viewed', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&sort_by=popularity.desc`;
    await updateRenderParams(url, 'movie', 'most_viewed', req, res);
});

app.get('/movie/top-rated', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/discover/movie?api_key=${apiKey}&sort_by=vote_average.desc`;
    await updateRenderParams(url, 'movie', 'top_rated', req, res);
});

app.get('/tv/alphabetical', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/discover/tv?api_key=${apiKey}&sort_by=original_name.asc`;
    await updateRenderParams(url, 'tv', 'alphabetical', req, res);
});


app.get('/tv/most-viewed', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/discover/tv?api_key=${apiKey}&sort_by=popularity.desc`;
    await updateRenderParams(url, 'tv', 'most_viewed', req, res);
});

app.get('/tv/top-rated', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const url = `https://api.themoviedb.org/3/discover/tv?api_key=${apiKey}&sort_by=vote_average.desc`;
    await updateRenderParams(url, 'tv', 'top_rated', req, res);
});

app.post('/popisi/kreiraj', async (req, res) => {
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
    connection.query(sql, [naziv, tip_popisa, userId, ''], (err) => {
        connection.end();
        if (err) {
            console.error('Greška prilikom stvaranja popisa:', err);
            return res.status(500).send('Pogreška prilikom stvaranja popisa.');
        }
        res.redirect('/popisi');
    });
});

app.get('/popisi', async (req, res) => {
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

    const sql = 'SELECT * FROM popisi WHERE korisnik_id = ?';
    connection.query(sql, [userId], (err, results) => {
        connection.end();
        if (err) {
            console.error('Greška prilikom dohvaćanja popisa:', err);
            return res.status(500).send('Pogreška prilikom dohvaćanja popisa.');
        }
        res.render('popisi', { popisi: results });
    });
});

app.post('/popisi/dodaj', (req, res) => {
    const { popis_id, sadrzaj_id } = req.body;
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.status(401).json({ error: "You must be logged in." });
    }

    if (!popis_id || !sadrzaj_id) {
        console.error("Missing data: ", req.body);
        return res.status(400).json({ error: "Invalid data." });
    }

    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const checkSql = `SELECT sadrzaj FROM popisi WHERE id = ? AND korisnik_id = ?`;
    connection.query(checkSql, [popis_id, korisnikId], (err, results) => {
        if (err) {
            console.error('Error checking list:', err);
            connection.end();
            return res.status(500).json({ error: 'Error checking list.' });
        }

        if (results.length > 0) {
            const existingContent = results[0].sadrzaj.split(',');
            if (existingContent.includes(sadrzaj_id)) {
                connection.end();
                return res.status(409).json({ error: 'Content already in list.' });
            }
        }

        const sql = `
            UPDATE popisi 
            SET sadrzaj = CASE 
                            WHEN sadrzaj = '' THEN ? 
                            ELSE CONCAT(sadrzaj, ',', ?) 
                          END 
            WHERE id = ? AND korisnik_id = ?
        `;

        connection.query(sql, [sadrzaj_id, sadrzaj_id, popis_id, korisnikId], (err) => {
            connection.end();
            if (err) {
                console.error('Error updating list:', err);
                return res.status(500).json({ error: 'Error updating list.' });
            }
            res.status(200).json({ success: 'Added to list successfully.' });
        });
    });
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
        sql += ' AND tip_popisa = ?';
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




app.get('/film/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const filmId = req.params.id;

    const filmUrl = `https://api.themoviedb.org/3/movie/${filmId}?api_key=${apiKey}&append_to_response=credits,videos,releases`;
    const recommendationsUrl = `https://api.themoviedb.org/3/movie/${filmId}/recommendations?api_key=${apiKey}`;

    const mysql = require('mysql');

    try {
        const [filmResponse, recommendationsResponse] = await Promise.all([
            axios.get(filmUrl),
            axios.get(recommendationsUrl),
        ]);

        const film = filmResponse.data;
        const preporuke = recommendationsResponse.data.results.slice(0, 7);

        const director = film.credits.crew.find(person => person.job === 'Director');

        const releaseInfo = film.releases.countries.find(country => country.iso_3166_1 === 'US');
        const pgRating = releaseInfo?.certification || 'N/A';

        const connection = mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        connection.connect();

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
                    res.status(500).send('Greška prilikom dohvaćanja komentara.');
                } else {
                    connection.query(
                        `SELECT COUNT(*) AS total FROM komentari WHERE film_id = ?`,
                        [filmId],
                        (countError, countResults) => {
                            if (countError) {
                                console.error('Greška prilikom prebrojavanja komentara:', countError);
                                res.status(500).send('Greška prilikom prebrojavanja komentara.');
                            } else {
                                const totalComments = countResults[0].total;

                                const userScores = results.map(row => row.ocjena);
                                const userScore = userScores.length > 0 
                                    ? (userScores.reduce((a, b) => a + b, 0) / userScores.length).toFixed(1) 
                                    : '0';

                                const userScoreColor = getScoreColor(userScore);
                                const tmdbScoreColor = getScoreColor(film.vote_average);

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
                                });
                            }
                        }
                    );
                }
            }
        );

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

    try {
        const filmResponse = await axios.get(`https://api.themoviedb.org/3/movie/${filmId}?api_key=${apiKey}&append_to_response=credits`);
        const film = filmResponse.data;

        res.render('detalji_film', {
            film,
            userScore: film.vote_average.toFixed(1),
            userScoreColor: getScoreColor(film.vote_average),
        });
    } catch (error) {
        console.error("Error fetching movie details:", error);
        res.status(500).send("Error loading details.");
    }
});


app.get('/serija/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const serijaId = req.params.id;

    const serijaUrl = `https://api.themoviedb.org/3/tv/${serijaId}?api_key=${apiKey}&append_to_response=videos,credits,recommendations`;

    try {
        const response = await axios.get(serijaUrl);
        const serija = response.data;

        const preporuke = serija.recommendations?.results?.slice(0, 7) || [];

        const creator = serija.created_by.length > 0 ? serija.created_by[0].name : 'N/A';
        const trailer = serija.videos?.results?.find(video => video.type === "Trailer");
        if (!trailer) {
            console.log("Trailer nije pronađen za ovu seriju.");
        }

        const mysql = require('mysql');
        const connection = mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        connection.connect();

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
                    res.status(500).send('Greška prilikom dohvaćanja komentara za seriju.');
                } else {
                    connection.query(
                        `SELECT COUNT(*) AS total FROM komentari WHERE serija_id = ?`,
                        [serijaId],
                        (countError, countResults) => {
                            if (countError) {
                                console.error('Greška prilikom prebrojavanja komentara:', countError);
                                res.status(500).send('Greška prilikom prebrojavanja komentara.');
                            } else {
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
                                });
                            }
                        }
                    );
                }
            }
        );        

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

    try {
        const serijaResponse = await axios.get(`https://api.themoviedb.org/3/tv/${serijaId}?api_key=${apiKey}&append_to_response=credits`);
        const serija = serijaResponse.data;

        res.render('detalji_serija', {
            serija,
            userScore: serija.vote_average.toFixed(1),
            userScoreColor: getScoreColor(serija.vote_average),
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

app.get('/komentar/:tip/:id', async (req, res) => {
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

app.post('/dodaj-komentar', (req, res) => {
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

app.post('/uredi-komentar', (req, res) => {
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

app.post('/izbrisi-komentar', (req, res) => {
    const { filmId, serijaId } = req.body;
    const korisnikId = req.session.userId;

    console.log('Deleting comment:', { filmId, serijaId, korisnikId });


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
    console.log(`Fetching comments for ${req.params.tip} with ID ${req.params.id}`);

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
        console.log('Fetched comments:', results);
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

app.listen(port, () => {
    console.log(`Server pokrenut na http://localhost:${port}`);
});
