const GhausiaLot = require("../models/GhausiaLot");

const LOOKBACK_DAYS = 90;

/**
 * Calculate performance metrics and generate Roman Urdu motivational
 * messages for a single party (identified by partyId + ownerId).
 */
async function calculatePartyMotivation({ partyId, partyName, ownerId }) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Build query — match by partyId or partyName
  const partyMatch = [];
  const pid = String(partyId || "").trim();
  const pname = String(partyName || "").trim();
  if (pid) partyMatch.push({ partyId: pid });
  if (pname) partyMatch.push({ partyName: new RegExp(`^${pname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  if (!partyMatch.length) return { messages: [], stats: {} };

  const lots = await GhausiaLot.find({
    userId: ownerId,
    $or: partyMatch,
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!lots.length) {
    return {
      messages: [
        {
          type: "warning",
          icon: "📋",
          title: "Koi kaam nahi mila",
          body: "Pichle 3 mahine mein koi lot assign nahi hua. Business se rabta karein.",
        },
      ],
      stats: { totalLots: 0 },
    };
  }

  // ── Metrics ──
  const totalLots = lots.length;
  const completedLots = lots.filter(
    (l) => l.status === "completed" || l.status === "received back"
  );
  const completedCount = completedLots.length;
  const rejectedLots = lots.filter((l) => l.status === "rejected");
  const rejectedCount = rejectedLots.length;
  const pendingLots = lots.filter(
    (l) =>
      l.status === "pending" ||
      l.status === "dispatched" ||
      l.status === "in progress" ||
      l.status === "processing"
  );
  const pendingCount = pendingLots.length;

  // Average return days (allotDate/receivedDate → receivedBackDate/completionApprovedAt)
  const returnDays = [];
  completedLots.forEach((l) => {
    const start = l.allotDate || l.receivedDate || l.createdAt;
    const end = l.completionApprovedAt || l.receivedBackDate || l.updatedAt;
    if (start && end) {
      const days = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)));
      if (!Number.isNaN(days)) {
        returnDays.push(days);
      }
    }
  });
  const avgReturnDays = returnDays.length
    ? Math.round((returnDays.reduce((s, d) => s + d, 0) / returnDays.length) * 10) / 10
    : null;
  const fastestReturn = returnDays.length ? Math.min(...returnDays) : null;

  // Current month completed
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const completedThisMonth = completedLots.filter(
    (l) => new Date(l.completionApprovedAt || l.receivedBackDate || l.updatedAt) >= thisMonthStart
  ).length;

  // Last month completed (for comparison)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const completedLastMonth = completedLots.filter((l) => {
    const d = new Date(l.completionApprovedAt || l.receivedBackDate || l.updatedAt);
    return d >= lastMonthStart && d < thisMonthStart;
  }).length;

  // Rejection rate
  const rejectionRate = totalLots > 0 ? Math.round((rejectedCount / totalLots) * 100) : 0;

  // Streak: consecutive approved lots without rejection (from newest)
  let streak = 0;
  const sorted = [...lots].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  for (const l of sorted) {
    if (l.status === "completed" || l.status === "received back") {
      streak++;
    } else if (l.status === "rejected") {
      break;
    }
    // skip pending/dispatched — they are neither good nor bad
  }

  // Total bill value completed
  const totalBillCompleted = completedLots.reduce(
    (s, l) => s + (Number(l.billAmount) || 0),
    0
  );

  const stats = {
    totalLots,
    completedCount,
    rejectedCount,
    pendingCount,
    avgReturnDays,
    fastestReturn,
    completedThisMonth,
    completedLastMonth,
    rejectionRate,
    streak,
    totalBillCompleted,
  };

  // ── Generate Messages (max 3, prioritized) ──
  const achievements = [];
  const encouragements = [];
  const warnings = [];

  // 1. Fast return
  if (avgReturnDays !== null && avgReturnDays <= 7) {
    achievements.push({
      type: "achievement",
      icon: "🚀",
      title: "Bohat tez kaam!",
      body: `Aap average ${avgReturnDays} din mein lot return karte hain — Shandar speed!`,
    });
  } else if (avgReturnDays !== null && avgReturnDays <= 14) {
    encouragements.push({
      type: "encouragement",
      icon: "⚡",
      title: "Achi speed hai!",
      body: `Average ${avgReturnDays} din mein lot return — thori aur mehnat se top pe aa sakte hain!`,
    });
  } else if (avgReturnDays !== null && avgReturnDays > 20) {
    warnings.push({
      type: "warning",
      icon: "⏳",
      title: "Return slow hai",
      body: `Average ${avgReturnDays} din lag rahe hain lot return mein — jaldi kaam karne ki koshish karein.`,
    });
  }

  // 2. Completion streak
  if (streak >= 10) {
    achievements.push({
      type: "achievement",
      icon: "🔥",
      title: `${streak} lots lagatar approved!`,
      body: "Koi rejection nahi — Behtareen quality ka kaam kar rahe hain!",
    });
  } else if (streak >= 5) {
    encouragements.push({
      type: "encouragement",
      icon: "🔥",
      title: `${streak} lots lagatar bina rejection!`,
      body: "Bohat acha — isi tarah quality maintain karein!",
    });
  }

  // 3. Monthly volume comparison
  if (completedThisMonth > 0 && completedThisMonth > completedLastMonth) {
    const diff = completedThisMonth - completedLastMonth;
    achievements.push({
      type: "achievement",
      icon: "🌟",
      title: `Is mahine ${completedThisMonth} lots complete!`,
      body:
        completedLastMonth > 0
          ? `Pichle mahine se ${diff} zyada — Great progress!`
          : "Bohat acha kaam ho raha hai — keep going!",
    });
  } else if (completedThisMonth > 0 && completedThisMonth === completedLastMonth) {
    encouragements.push({
      type: "encouragement",
      icon: "📊",
      title: `Is mahine ${completedThisMonth} lots complete`,
      body: "Pichle mahine jitna hi — thora aur push karein!",
    });
  } else if (completedThisMonth < completedLastMonth && completedLastMonth > 0) {
    warnings.push({
      type: "warning",
      icon: "📉",
      title: `Is mahine sirf ${completedThisMonth} lots complete`,
      body: `Pichle mahine ${completedLastMonth} the — speed barhaein!`,
    });
  }

  // 4. Zero rejection rate
  if (rejectionRate === 0 && completedCount >= 3) {
    achievements.push({
      type: "achievement",
      icon: "✅",
      title: "0% rejection rate!",
      body: "Aap ka koi bhi lot reject nahi hua — Perfect quality record!",
    });
  } else if (rejectionRate > 20) {
    warnings.push({
      type: "warning",
      icon: "⚠️",
      title: `Rejection rate ${rejectionRate}% hai`,
      body: `${rejectedCount} lots reject hue hain — quality pe dhyan dein.`,
    });
  }

  // 5. Pending lots alert
  if (pendingCount >= 5) {
    warnings.push({
      type: "warning",
      icon: "📋",
      title: `${pendingCount} lots pending hain`,
      body: "Pending kaam zyada hai — jaldi complete karne ki koshish karein.",
    });
  }

  // 6. Fastest return achievement
  if (fastestReturn !== null && fastestReturn <= 3 && completedCount >= 2) {
    achievements.push({
      type: "achievement",
      icon: "⚡",
      title: `Sabse tez lot sirf ${fastestReturn} din mein!`,
      body: "Super fast return — bohat zabardast kaam!",
    });
  }

  // 7. High bill value
  if (totalBillCompleted >= 100000) {
    const formatted = `₨${Math.round(totalBillCompleted / 1000)}K`;
    encouragements.push({
      type: "encouragement",
      icon: "💰",
      title: `${formatted} ka kaam complete!`,
      body: "3 mahine mein bohat acha kaam kia hai — isi tarah lagey rahein!",
    });
  }

  // Prioritize: achievements first, then encouragement, then warnings. Max 3.
  const messages = [...achievements, ...encouragements, ...warnings].slice(0, 3);

  // If no messages generated, add a neutral one
  if (!messages.length) {
    messages.push({
      type: "encouragement",
      icon: "👋",
      title: "Kaam jaari hai",
      body: `Aap ke paas ${totalLots} lots hain pichle 3 mahine mein — mehnat jaari rakhein!`,
    });
  }

  return { messages, stats };
}

/**
 * Calculate motivation for ALL parties of an org (for admin dashboard).
 * Returns an array of { partyId, partyName, messages, stats }.
 */
async function calculateAllPartiesMotivation({ ownerId, parties }) {
  if (!parties || !parties.length) return [];

  const results = await Promise.all(
    parties.map(async (p) => {
      const { messages, stats } = await calculatePartyMotivation({
        partyId: String(p._id || p.id || ""),
        partyName: p.name,
        ownerId,
      });
      return {
        partyId: String(p._id || p.id || ""),
        partyName: p.name || "Unknown",
        messages,
        stats,
      };
    })
  );

  // Filter out parties with 0 lots (no data)
  return results.filter((r) => r.stats.totalLots > 0 || r.messages.length > 0);
}

module.exports = {
  calculatePartyMotivation,
  calculateAllPartiesMotivation,
};
