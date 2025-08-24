const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors'); // <-- ADD THIS LINE
const User = require('./models/User');

const app = express();

// Set up CORS to allow requests ONLY from your Netlify frontend
const corsOptions = {
    origin: 'https://shadowassasins.netlify.com'
};

app.use(cors(corsOptions)); // <-- ADD THIS LINE
app.use(express.json());

// Your secret key for JWTs. Use an environment variable in production.
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key';

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB Atlas!'))
    .catch(err => console.error('Could not connect to database...', err));

// ... The rest of your server.js code is unchanged ...
