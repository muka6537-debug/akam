// Director Admissions view of the Program + Batch fee structures synced
// into the Fee Module from admission cycles. /api/fee-structures/*
const express = require('express');
const prisma = require('../utils/prisma');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { syncCycle, shapeStructure } = require('../services/feeStructure');

const router = express.Router();

router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const rows = await prisma.batchFeeStructure.findMany({ orderBy: [{ batch: 'desc' }, { programCode: 'asc' }] });
    res.json({ structures: rows.map(shapeStructure) });
  } catch (e) {
    console.error('List fee structures error:', e);
    res.status(500).json({ error: 'Failed to load fee structures' });
  }
});

// Re-sync a cycle (e.g. after editing its fee breakdown). Locked items,
// including the semester-fee snapshot, are never changed by a re-sync.
router.post('/sync/:cycleId', authenticate, requireAdmin, async (req, res) => {
  try {
    const results = await syncCycle(parseInt(req.params.cycleId, 10), { role: 'DirectorAdmissions', label: req.user.email });
    if (!results.length) return res.status(404).json({ error: 'Admission cycle not found or has no programs' });
    res.json({
      structures: results.map((r) => r.structure),
      createdHeads: [...new Set(results.flatMap((r) => r.createdHeads))],
    });
  } catch (e) {
    console.error('Fee structure sync error:', e);
    res.status(500).json({ error: 'Failed to sync fee structures' });
  }
});

module.exports = router;
