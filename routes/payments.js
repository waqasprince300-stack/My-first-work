const express = require('express');
const router = express.Router();
const Payment = require('../models/Payment');
const Party = require('../models/Party');
const { getBusinessOwnerFilter, getDataOwnerId, getOwnerFilter, getPartyPaymentOrConditions, isParty, requireAdminUser, isTenantAdmin } = require('../utils/access');
const { parsePaginationQuery, paginatedJson } = require('../utils/pagination');

const normalize = (doc) => ({ ...doc.toObject(), id: doc._id.toString() });
const stripOwnership = ({ userId, ...data }) => data;

const withPartyId = async (payload, userId) => {
  const data = { ...payload };
  if (!data.partyId && data.party && String(data.party).toLowerCase() !== 'owner') {
    const party = await Party.findOne({ userId, name: data.party });
    if (party) data.partyId = String(party._id);
  }
  return data;
};

// Get all payments
router.get('/', async (req, res) => {
  try {
    const allWorkspaces = String(req.query.scope || '').toLowerCase() === 'all' && isTenantAdmin(req.user);

    const partyAllBiz = String(req.query.partyScope || '').toLowerCase() === 'all' && isParty(req.user);

    let filter;
    if (isParty(req.user)) {
      const partyMatch = partyAllBiz
        ? getPartyPaymentOrConditions(req.user)
        : [
            { partyId: String(req.user.partyId || '') },
            { party: req.user.partyName || '' },
          ];

      filter = {
        ...getOwnerFilter(req),
        ...(partyAllBiz ? {} : getBusinessOwnerFilter(req)),
        $or: partyMatch,
      };
    } else if (allWorkspaces) {
      filter = { ...getOwnerFilter(req) };
    } else {
      filter = { ...getOwnerFilter(req), ...getBusinessOwnerFilter(req) };
    }

    const typeQ = String(req.query.type || '').trim();
    if (typeQ) filter.type = typeQ;

    const bizOwnerQ = String(req.query.businessOwnerId || '').trim();
    if (bizOwnerQ) filter.businessOwnerId = bizOwnerQ;

    const partyKind = String(req.query.partyKind || '').trim().toLowerCase();
    if (partyKind === 'owner') {
      filter.party = /^owner$/i;
    } else if (partyKind === 'nonowner') {
      filter.party = { $not: /^owner$/i };
    }

    const pagination = parsePaginationQuery(req);
    const sort = { createdAt: -1 };
    if (pagination.paginate) {
      const [rows, total] = await Promise.all([
        Payment.find(filter).sort(sort).skip(pagination.skip).limit(pagination.limit).lean(),
        Payment.countDocuments(filter),
      ]);
      return paginatedJson(
        res,
        rows.map((doc) => ({ ...doc, id: String(doc._id) })),
        total,
        pagination.page,
        pagination.limit,
      );
    }

    const payments = await Payment.find(filter).sort(sort).lean();
    res.json(payments.map((doc) => ({ ...doc, id: String(doc._id) })));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching payments', error: error.message });
  }
});

// Get single payment
router.get('/:id', async (req, res) => {
  try {
    const filter = isParty(req.user)
      ? {
        _id: req.params.id,
        ...getOwnerFilter(req),
        ...getBusinessOwnerFilter(req),
        $or: [
          { partyId: String(req.user.partyId || '') },
          { party: req.user.partyName || '' },
        ],
      }
      : { _id: req.params.id, ...getOwnerFilter(req), ...getBusinessOwnerFilter(req) };
    const payment = await Payment.findOne(filter);
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    res.json(normalize(payment));
  } catch (error) {
    res.status(500).json({ message: 'Error fetching payment', error: error.message });
  }
});

// Create payment
router.post('/', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const data = await withPartyId(stripOwnership(req.body), userId);
    const payment = new Payment({ ...data, userId, businessOwnerId: req.businessOwnerId });
    const saved = await payment.save();
    res.status(201).json(normalize(saved));
  } catch (error) {
    res.status(400).json({ message: 'Error creating payment', error: error.message });
  }
});

// Update payment
router.patch('/:id', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const userId = getDataOwnerId(req.user);
    const data = await withPartyId(stripOwnership(req.body), userId);
    const payment = await Payment.findOneAndUpdate(
      { _id: req.params.id, userId, businessOwnerId: req.businessOwnerId },
      data,
      { new: true, runValidators: true }
    );
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    res.json(normalize(payment));
  } catch (error) {
    res.status(400).json({ message: 'Error updating payment', error: error.message });
  }
});

// Delete payment
router.delete('/:id', async (req, res) => {
  try {
    if (!requireAdminUser(req, res)) return;
    const payment = await Payment.findOneAndDelete({ _id: req.params.id, userId: getDataOwnerId(req.user), businessOwnerId: req.businessOwnerId });
    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }
    res.json({ message: 'Payment deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting payment', error: error.message });
  }
});

module.exports = router;
