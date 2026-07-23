(async () => {
  const base = "http://localhost:3001";
  const fetch = global.fetch;
  const out = (label, data) =>
    console.log("\n=== " + label + " ===\n", JSON.stringify(data, null, 2));
  try {
    // 1. Signup admin
    const ts = Date.now().toString().slice(-6);
    const adminEmail = `seamandgrace+test${ts}@gmail.com`;
    const admin = {
      name: "Test Admin",
      email: adminEmail,
      password: "Password123!",
      role: "admin",
    };
    let r = await fetch(base + "/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(admin),
    });
    const s = await r.json();
    out("signup", s);
    let token = s.token;
    if (!token) {
      // If signup returned user without token (pending), try login
      r = await fetch(base + "/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: admin.email,
          password: admin.password,
          deviceId: "dev-test-1",
        }),
      });
      const l = await r.json();
      out("login", l);
      token = l.token;
    }
    if (!token) throw new Error("No token obtained");

    const auth = { Authorization: "Bearer " + token };

    // 2. Create business owner
    r = await fetch(base + "/api/businessOwners", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Test Workspace" }),
    });
    const owner = await r.json();
    out("businessOwner", owner);

    // 3. Create party
    r = await fetch(base + "/api/parties", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Test Party", phone: "03001234567" }),
    });
    const party = await r.json();
    out("party", party);

    // 4. Create lot assigned to party (status dispatched to trigger ledger sync)
    const today = new Date().toISOString().slice(0, 10);
    const lotPayload = {
      lotNumber: "TST-1-" + Date.now(),
      designNo: "D-TEST",
      description: "Auto test lot",
      itemType: "Lawn",
      colors: 1,
      pieces: 10,
      allotDate: today,
      dispatchDate: today,
      status: "dispatched",
      partyId: String(party._id || party.id),
      partyName: party.name || "Test Party",
      billAmount: 100,
    };
    r = await fetch(base + "/api/ghausiaLots", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(lotPayload),
    });
    const createdLot = await r.json();
    out("createdLot", createdLot);

    // 5. Fetch party ledger
    r = await fetch(base + "/api/partyLedger", {
      method: "GET",
      headers: { ...auth },
    });
    const ledger = await r.json();
    out("partyLedger", ledger.slice(0, 5));

    console.log("\nAll tests done.");
  } catch (err) {
    console.error("Test script error:", err);
  }
})();
