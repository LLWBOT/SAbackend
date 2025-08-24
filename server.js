const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const User = require('./models/User');

const app = express();

const corsOptions = {
    origin: 'https://shadowassasins.netlify.app'
};

app.use(cors(corsOptions));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key';

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB Atlas!'))
    .catch(err => console.error('Could not connect to database...', err));

// --- REST API Endpoints ---

app.post('/api/signup', async (req, res) => {
    try {
        const hashedPassword = await bcrypt.hash(req.body.password, 10);
        const user = new User({
            username: req.body.username,
            password: hashedPassword
        });
        await user.save();
        res.status(201).send('User created successfully!');
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).send('Username already exists.');
        }
        res.status(500).send('Error creating user.');
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.body.username });
        if (!user) {
            return res.status(404).send('Invalid username or password.');
        }

        const isMatch = await bcrypt.compare(req.body.password, user.password);
        if (!isMatch) {
            return res.status(401).send('Invalid username or password.');
        }

        const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token, username: user.username });
    } catch (error) {
        res.status(500).send('Server error.');
    }
});

app.post('/api/update-username', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).send('Authentication failed.');
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const { newUsername } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            decoded.userId, 
            { username: newUsername }, 
            { new: true, runValidators: true }
        );

        if (!updatedUser) {
            return res.status(404).send('User not found.');
        }
        res.send('Username updated successfully.');
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).send('Username already exists.');
        }
        res.status(401).send('Invalid token or unauthorized.');
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const topPlayers = await User.find().sort({ points: -1 }).limit(100).select('username points -_id');
        res.json(topPlayers);
    } catch (error) {
        res.status(500).send('Error fetching leaderboard.');
    }
});

app.get('/api/user/score', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).send('Authentication failed.');
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId).select('points');
        if (!user) {
            return res.status(404).send('User not found.');
        }
        res.json({ points: user.points });
    } catch (error) {
        res.status(401).send('Invalid token or unauthorized.');
    }
});

// --- WebSocket Server ---

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const waitingPlayers = [];
const activeGames = new Map();

wss.on('connection', ws => {
    let isAuthenticated = false;

    ws.on('message', async message => {
        const data = JSON.parse(message);

        if (data.type === 'authenticate' && data.token) {
            try {
                const user = jwt.verify(data.token, JWT_SECRET);
                ws.user = user;
                isAuthenticated = true;
                ws.send(JSON.stringify({ type: 'status', message: 'Authentication successful. Searching for opponent...' }));

                waitingPlayers.push(ws);

                if (waitingPlayers.length >= 2) {
                    const player1 = waitingPlayers.shift();
                    const player2 = waitingPlayers.shift();

                    const gameId = Math.random().toString(36).substring(7);
                    activeGames.set(gameId, [player1, player2]);

                    player1.gameId = gameId;
                    player2.gameId = gameId;

                    player1.send(JSON.stringify({ type: 'matchFound', opponent: player2.user.username }));
                    player2.send(JSON.stringify({ type: 'matchFound', opponent: player1.user.username }));
                }

            } catch (err) {
                ws.close(1008, 'Invalid token.');
            }
        } else if (isAuthenticated) {
            const game = activeGames.get(ws.gameId);
            if (!game) return;

            const opponent = game.find(p => p !== ws);

            if (data.type === 'leave') {
                if (opponent && opponent.readyState === WebSocket.OPEN) {
                    opponent.send(JSON.stringify({ type: 'finalResult', status: 'Your opponent left the game. You win!' }));
                    updateScore(opponent.user.username, 10);
                }
                ws.close();
                activeGames.delete(ws.gameId);
                return;
            }

            if (!opponent || opponent.readyState !== WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'finalResult', status: 'Your opponent disconnected. You win!' }));
                updateScore(ws.user.username, 10);
                activeGames.delete(ws.gameId);
                return;
            }

            opponent.send(message);

            if (data.type === 'gameover') {
                const winnerName = data.winner;
                const loserName = data.loser;

                if (winnerName === ws.user.username) {
                    updateScore(winnerName, 10);
                    ws.send(JSON.stringify({ type: 'finalResult', status: 'You won!' }));
                    opponent.send(JSON.stringify({ type: 'finalResult', status: 'You were defeated.' }));
                    updateScore(loserName, -5);
                } else {
                    updateScore(winnerName, 10);
                    opponent.send(JSON.stringify({ type: 'finalResult', status: 'You won!' }));
                    ws.send(JSON.stringify({ type: 'finalResult', status: 'You were defeated.' }));
                    updateScore(loserName, -5);
                }
                activeGames.delete(ws.gameId);
            }
        }
    });

    ws.on('close', () => {
        const index = waitingPlayers.indexOf(ws);
        if (index > -1) {
            waitingPlayers.splice(index, 1);
        }

        activeGames.forEach((game, gameId) => {
            const player = game.find(p => p === ws);
            if (player) {
                const opponent = game.find(p => p !== ws);
                if (opponent && opponent.readyState === WebSocket.OPEN) {
                    opponent.send(JSON.stringify({ type: 'finalResult', status: 'Your opponent disconnected. You win!' }));
                    updateScore(opponent.user.username, 10);
                }
                activeGames.delete(gameId);
            }
        });
    });
});

const updateScore = async (username, points) => {
    try {
        await User.findOneAndUpdate(
            { username: username },
            { $inc: { points: points } },
            { new: true }
        );
    } catch (error) {
        console.error('Error updating score:', error);
    }
};

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
