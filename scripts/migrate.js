require("dotenv").config();
const _mongoose = require("mongoose");
const _fs = require("fs");
const _path = require("path");

// Import models
const _Collection = require("../models/Collection");
const _Party = require("../models/Party");
const _GhausiaLot = require("../models/GhausiaLot");
const _Payment = require("../models/Payment");
const _PartyLedger = require("../models/PartyLedger");
const _RateCalculation = require("../models/RateCalculation");

// const migrateData = async () => {
//   try {
//     // Connect to MongoDB
//     await mongoose.connect(process.env.MONGODB_URI);
//     console.log('Connected to MongoDB');

//     // Read JSON data
//     const dbJsonPath = path.join(__dirname, '../../textile-app/db.json');
//     const rawData = fs.readFileSync(dbJsonPath, 'utf8');
//     const jsonData = JSON.parse(rawData);

//     console.log('\n📊 Starting Migration...\n');

//     // Helper function to remove old IDs
//     const cleanData = (data) => {
//       return data.map(item => {
//         const cleaned = { ...item };
//         delete cleaned.id;
//         return cleaned;
//       });
//     };

//     // Map old status values
//     const mapCollectionStatus = (status) => {
//       const statusMap = {
//         'in-progress': 'pending',
//         'in progress': 'pending',
//         'completed': 'completed',
//         'Completed': 'completed',
//         'pending': 'pending',
//         'cancelled': 'cancelled'
//       };
//       return statusMap[status] || 'pending';
//     };

//     // Migrate Collections
//     if (jsonData.collections && jsonData.collections.length > 0) {
//       await Collection.deleteMany({});
//       const cleanedCollections = cleanData(jsonData.collections).map(c => ({
//         ...c,
//         status: mapCollectionStatus(c.status)
//       }));
//       const collections = await Collection.insertMany(cleanedCollections);
//       console.log(`✅ Migrated ${collections.length} collections`);
//     }

//     // Migrate Parties
//     if (jsonData.parties && jsonData.parties.length > 0) {
//       await Party.deleteMany({});
//       const parties = await Party.insertMany(
//         cleanData(jsonData.parties).map(p => ({
//           ...p,
//           name: p.name || p.partyName || 'Unknown',
//           status: 'active'
//         }))
//       );
//       console.log(`✅ Migrated ${parties.length} parties`);
//     }

//     // Migrate Ghausia Lots
//     if (jsonData.ghausiaLots && jsonData.ghausiaLots.length > 0) {
//       await GhausiaLot.deleteMany({});
//       const validLots = cleanData(jsonData.ghausiaLots).filter(lot =>
//         lot.lotNumber || lot.lotNo
//       ).map(lot => ({
//         lotNumber: lot.lotNumber || lot.lotNo || 'Unknown',
//         partyName: lot.partyName || 'Unknown',
//         itemType: lot.itemType || lot.fabric || 'Unknown',
//         quantity: lot.quantity || lot.pieces || 1,
//         unit: lot.unit || 'pieces',
//         rate: lot.rate || 0,
//         totalAmount: lot.totalAmount || lot.billAmount || 0,
//         status: 'completed',
//         notes: lot.description || lot.notes || ''
//       }));

//       if (validLots.length > 0) {
//         const ghausiaLots = await GhausiaLot.insertMany(validLots);
//         console.log(`✅ Migrated ${ghausiaLots.length} ghausia lots`);
//       } else {
//         console.log(`⚠️  No ghausia lots to migrate`);
//       }
//     }

//     // Migrate Payments
//     if (jsonData.payments && jsonData.payments.length > 0) {
//       await Payment.deleteMany({});
//       const validPayments = cleanData(jsonData.payments).filter(p =>
//         p.partyName || p.partyId
//       ).map(p => ({
//         partyId: p.partyId || '',
//         partyName: p.partyName || 'Unknown',
//         amount: p.amount || 0,
//         paymentDate: p.paymentDate || new Date(),
//         paymentMethod: p.paymentMethod || 'cash',
//         referenceNumber: p.referenceNumber || '',
//         notes: p.notes || '',
//         status: 'completed'
//       }));

//       if (validPayments.length > 0) {
//         const payments = await Payment.insertMany(validPayments);
//         console.log(`✅ Migrated ${payments.length} payments`);
//       }
//     }

//     // Migrate Party Ledger
//     if (jsonData.partyLedger && jsonData.partyLedger.length > 0) {
//       await PartyLedger.deleteMany({});
//       const validLedger = cleanData(jsonData.partyLedger).filter(l =>
//         l.partyName && l.amount
//       ).map(l => ({
//         partyId: l.partyId || '',
//         partyName: l.partyName,
//         type: l.type || 'debit',
//         amount: l.amount,
//         description: l.description || '',
//         date: l.date || new Date()
//       }));

//       if (validLedger.length > 0) {
//         const ledgerEntries = await PartyLedger.insertMany(validLedger);
//         console.log(`✅ Migrated ${ledgerEntries.length} ledger entries`);
//       }
//     }

//     // Migrate Rate Calculations
//     if (jsonData.rateCalculations && jsonData.rateCalculations.length > 0) {
//       await RateCalculation.deleteMany({});
//       const validCalcs = cleanData(jsonData.rateCalculations).filter(r =>
//         r.itemType && r.baseRate
//       ).map(r => ({
//         itemType: r.itemType,
//         baseRate: r.baseRate,
//         quantity: r.quantity || 1,
//         discount: r.discount || 0,
//         tax: r.tax || 0,
//         finalRate: r.finalRate || r.baseRate,
//         totalAmount: r.totalAmount || (r.baseRate * (r.quantity || 1))
//       }));

//       if (validCalcs.length > 0) {
//         const rateCalcs = await RateCalculation.insertMany(validCalcs);
//         console.log(`✅ Migrated ${rateCalcs.length} rate calculations`);
//       }
//     }

//     console.log('\n✨ Migration completed successfully!\n');
//     process.exit(0);

//   } catch (error) {
//     console.error('\n❌ Migration failed:', error.message);
//     process.exit(1);
//   }
// };

// migrateData();
