require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const mysql = require('mysql');


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
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'process.env.SESSION_SECRET',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // HTTPS - true
}));
app.use((req, res, next) => {
    res.locals.session = req.session || {};
    next();
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
    res.render('pocetna', { title: 'Filmovi Popis' });
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

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    const mysql = require('mysql');
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
                console.error('Greška prilikom prijave:', error);
                return res.status(401).send('Pogrešan username ili lozinka.');
            }

            const user = results[0];

            try {
                const passwordMatch = await bcrypt.compare(password, user.password);
                if (passwordMatch) {
                    req.session.userId = user.id;
                    req.session.username = user.username;
                    req.session.role = user.role;
                    res.redirect('/');
                } else {
                    res.status(401).send('Pogrešan username ili lozinka.');
                }
            } catch (err) {
                console.error('Greška prilikom provjere lozinke:', err);
                res.status(500).send('Greška na serveru.');
            }
        }
    );
});


app.get('/login', (req, res) => {
    res.render('login', { session: req.session });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});


app.get('/pretrazi', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const naziv = req.query.naziv || '';
    const category = req.query.category || 'movie';
    const page = parseInt(req.query.page) || 1;

    const url = `https://api.themoviedb.org/3/search/${category}?api_key=${apiKey}&query=${naziv}&page=${page}`;
    try {
        const response = await axios.get(url);
        const data = response.data;

        const totalPages = data.total_pages;

        const pagination = generatePagination(page, totalPages);

        res.render('pretrazi_film', { data, naziv, category, pagination, page, totalPages });
    } catch (error) {
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
});

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
}

app.post('/pretrazi', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const naziv = req.body.naziv || '';
    const category = req.body.category || 'movie';
    const page = req.query.page || 1;

    const url = `https://api.themoviedb.org/3/search/${category}?api_key=${apiKey}&query=${naziv}&page=${page}`;
    try {
        const response = await axios.get(url);
        const data = response.data;

        const totalPages = data.total_pages;
        const pagination = generatePagination(page, totalPages);

        res.render('pretrazi_film', { data, naziv, category, pagination, page, totalPages });
    } catch (error) {
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
});

app.get('/dodaj/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const filmId = req.params.id;

    const url = `https://api.themoviedb.org/3/movie/${filmId}?api_key=${apiKey}`;
    try {
        const response = await axios.get(url);
        const film = response.data;

        const mysql = require('mysql');
        const connection = mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        connection.connect();

        const naziv = connection.escape(film.title);
        const godina_izdanja = connection.escape(film.release_date.substr(0, 4));
        const zanr = connection.escape(film.genres.length > 0 ? film.genres[0].name : 'Nepoznato');

        const sql = `INSERT INTO filmovi (naziv, godina_izdanja, zanr) VALUES (${naziv}, ${godina_izdanja}, ${zanr})`;

        connection.query(sql, (error, results) => {
            if (error) {
                console.error('Greška prilikom dodavanja filma:', error);
                res.status(500).send('Greška prilikom dodavanja filma u bazu.');
            } else {
                res.send('Film je uspješno dodan u bazu!');
            }
        });

        connection.end();

    } catch (error) {
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka o filmu.');
    }
});

app.get('/popis', (req, res) => {
    const mysql = require('mysql');
    const connection = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    connection.connect();

    const sql = 'SELECT * FROM filmovi';

    connection.query(sql, (error, results) => {
        if (error) {
            console.error('Greška prilikom dohvaćanja filmova:', error);
            res.status(500).send('Greška prilikom dohvaćanja filmova iz baze.');
        } else {
            res.render('popis_filmova', { films: results });
        }
    });

    connection.end();
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
            `SELECT k.tekst, k.ocjena, k.datum, korisnici.nadimak 
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
                        preporuke,
                        userScoreColor,
                        tmdbScoreColor,
                        filmId,
                    });
                }
            }
        );

        connection.end();
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
            `SELECT k.tekst, k.ocjena, k.datum, korisnici.nadimak 
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
                        preporuke,
                        userScoreColor,
                        tmdbScoreColor,
                        serijaId,
                    });
                }
            }
        );        

        connection.end();
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

app.post('/dodaj-komentar', (req, res) => {
    const { tekst, ocjena, filmId, serijaId, tip } = req.body;
    const korisnikId = req.session.userId;

    if (!korisnikId) {
        return res.status(401).send('You must be logged in to post a review.');
    }

    const mysql = require('mysql');
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

    connection.query(query, [tekst, ocjena, korisnikId, filmId || null, serijaId || null], (error) => {
        if (error) {
            console.error('Error adding comment:', error);
            return res.status(500).send('Error adding comment.');
        }
        res.redirect(filmId ? `/film/${filmId}` : `/serija/${serijaId}`);
    });

    connection.end();
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
