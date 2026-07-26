require('dotenv').config();
const mongoose = require('mongoose');
const GhausiaLot = require('./models/GhausiaLot');
const doc = new GhausiaLot({ id: '6a5b617aa2e3b54fc168a66f', lotNumber: '123' });
console.log("Created doc _id:", doc._id.toString());
console.log("Created doc id:", doc.id);
process.exit(0);
