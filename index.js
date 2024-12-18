require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = 3000;

function getScoreColor(score) {
    if (!score || isNaN(score) || score == 0) return '128, 128, 128'; // Default siva za "N/A"
    const red = Math.min(255, Math.max(0, 255 - Math.round((score / 10) * 255)));
    const green = Math.min(255, Math.max(0, Math.round((score / 10) * 255)));
    return `${red}, ${green}, 0`; // Vraća RGB vrijednosti bez alpha
}


// Postavi EJS kao view engine
app.set('view engine', 'ejs');

// Omogućimo korištenje javnog direktorija
app.use(express.static(path.join(__dirname, 'public')));

// Middleware za parsiranje tijela zahtjeva
app.use(express.urlencoded({ extended: true }));

// Početna stranica (Index)
app.get('/', (req, res) => {
    res.render('pocetna', { title: 'Filmovi Popis' });
});

// GET Ruta za Pretraga filmova/serija/ljudi
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

        // Kreiraj paginaciju
        const pagination = generatePagination(page, totalPages);

        // Dodaj 'pagination' u render podatke zajedno s ostalim informacijama
        res.render('pretrazi_film', { data, naziv, category, pagination, page, totalPages });
    } catch (error) {
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
});

// Funkcija za generiranje paginacije
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

// POST Ruta za Pretraga filmova/serija/ljudi
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


// Dodavanje filma (spremanje u bazu)
app.get('/dodaj/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const filmId = req.params.id;

    const url = `https://api.themoviedb.org/3/movie/${filmId}?api_key=${apiKey}`;
    try {
        const response = await axios.get(url);
        const film = response.data;

        // Spojite se na bazu i dodajte film
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

// Popis filmova
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

// Dodavanje rute za prikaz filma s recenzijom i preporukama
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

        // Dohvatite direktora iz credits
        const director = film.credits.crew.find(person => person.job === 'Director');

        // Dohvatite PG Rating iz releases
        const releaseInfo = film.releases.countries.find(country => country.iso_3166_1 === 'US');
        const pgRating = releaseInfo?.certification || 'N/A';

        // Spojite se na bazu za korisničke ocjene i komentare
        const connection = mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        connection.connect();

        connection.query(
            'SELECT ocjena, komentar FROM filmovi WHERE naziv = ?',
            [film.title],
            (error, results) => {
                if (error) {
                    console.error('Greška prilikom dohvaćanja korisničkih ocjena i komentara:', error);
                    res.status(500).send('Greška prilikom dohvaćanja korisničkih ocjena i komentara.');
                } else {
                    const userScores = results.map(row => row.ocjena);
                    const komentar = results.length > 0 ? results[0].komentar : null;
                    const userScore = userScores.length
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
                        komentar,
                        preporuke,
                        userScoreColor,
                        tmdbScoreColor,
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


// Ruta za prikaz svih glumaca i ekipe filma
app.get('/film/:id/glumci', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const filmId = req.params.id;

    const url = `https://api.themoviedb.org/3/movie/${filmId}/credits?api_key=${apiKey}`;
    try {
        const response = await axios.get(url);
        const credits = response.data;

        // Razvrstavanje ekipe prema kategorijama
        const crewByDepartment = credits.crew.reduce((acc, crewMember) => {
            if (!acc[crewMember.department]) {
                acc[crewMember.department] = [];
            }
            acc[crewMember.department].push(crewMember);
            return acc;
        }, {});

        res.render('film_glumci', { cast: credits.cast, crewByDepartment });
    } catch (error) {
        console.error('Greška prilikom dohvaćanja glumaca i ekipe filma:', error);
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja glumaca i ekipe filma.');
    }
});



// Dodavanje rute za prikaz serije
app.get('/serija/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const serijaId = req.params.id;

    const url = `https://api.themoviedb.org/3/tv/${serijaId}?api_key=${apiKey}&append_to_response=credits,seasons`;
    try {
        const response = await axios.get(url);
        const serija = response.data;

        res.render('serija', { serija });
    } catch (error) {
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka o seriji.');
    }
});

// Dodavanje rute za prikaz osobe
app.get('/osoba/:id', async (req, res) => {
    const apiKey = process.env.TMDB_API_KEY;
    const osobaId = req.params.id;

    const url = `https://api.themoviedb.org/3/person/${osobaId}?api_key=${apiKey}&append_to_response=movie_credits,tv_credits`;
    try {
        const response = await axios.get(url);
        const osoba = response.data;

        res.render('osoba', { osoba });
    } catch (error) {
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka o osobi.');
    }
});





// Pokreni server
app.listen(port, () => {
    console.log(`Server pokrenut na http://localhost:${port}`);
});
