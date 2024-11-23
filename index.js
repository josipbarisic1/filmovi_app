require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const port = 3000;

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
    const page = req.query.page || 1;

    const url = `https://api.themoviedb.org/3/search/${category}?api_key=${apiKey}&query=${naziv}&page=${page}`;
    try {
        const response = await axios.get(url);
        const data = response.data;
        res.render('pretrazi_film', { data, naziv, category, page: parseInt(page) });
    } catch (error) {
        res.status(500).send('Došlo je do pogreške prilikom dohvaćanja podataka.');
    }
});


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
        res.render('pretrazi_film', { data, naziv, category });
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

// Pokreni server
app.listen(port, () => {
    console.log(`Server pokrenut na http://localhost:${port}`);
});
