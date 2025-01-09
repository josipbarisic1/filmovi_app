require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

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
            'SELECT ocjena, komentar FROM serije WHERE naziv = ?',
            [serija.name],
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
                    const tmdbScoreColor = getScoreColor(serija.vote_average);

                    res.render('serija', {
                        serija,
                        creator,
                        seasons: serija.seasons,
                        tmdbRating: serija.vote_average.toFixed(1),
                        userScore,
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
