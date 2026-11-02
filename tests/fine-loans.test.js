// Fine loans, end to end: driver submits a fine → admin approves it → driver
// requests a loan for that ticket → admin approves → repaid from the wallet
// (by hand or automatically from ride earnings).
process.env.FINANCIAL_WRITES_ENABLED = "true";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startStack, stopStack, clearDb } = require("./harness");
const { load, makeDriver, fund } = require("./fixtures");

let app, Loan, Fine, Wallet, Transaction, fineRequests, loans, repayments;
before(async () => {
    app = await startStack();
    Loan = load("models/Loan.js"); Fine = load("models/Fine.js"); Wallet = load("models/Wallet.js"); Transaction = load("models/Transaction.js");
    fineRequests = load("services/fineRequestService.js"); loans = load("services/loanService.js"); repayments = load("services/repaymentService.js");
});
after(stopStack);
beforeEach(clearDb);

const TIN = "123456789";

/** A driver with enough history to borrow (5 successful transactions). */
async function borrower() {
    const driver = await makeDriver();
    await Transaction.insertMany(Array.from({ length: 5 }, () => ({ driverId: driver.user._id, amount: 1000, type: "ride_payment", status: "successful" })));
    return driver;
}

/** Driver submits fine `ticket` for `amount`; an admin approves it. */
async function approvedFine(driver, ticket, amount) {
    const res = await request(app).post("/api/fine-requests").set(driver.auth).send({ fineId: ticket, amount, reason: `TIN ${TIN}` });
    assert.equal(res.status, 201, res.body.message);
    await fineRequests.approveFineRequest(res.body.fineRequest._id, driver.user._id);
}

const askLoan = (driver, ticketNumber) => request(app).post("/api/loans/request").set(driver.auth).send({ tinNumber: TIN, ticketNumber });

test("a loan for an approved fine covers that fine (one interest charge, capped by the driver's limit)", async () => {
    const driver = await borrower();
    await approvedFine(driver, "TKT-001", 2000);
    const res = await askLoan(driver, "TKT-001");
    assert.equal(res.status, 201, res.body.message);
    const loan = res.body.data.loan;
    assert.equal(loan.loanAmount, 2000, "loan pays the fine itself, not 0 and not the fine plus its own interest");
    assert.equal(loan.totalWithInterest, 2100, "5% charged once");
    assert.equal(loan.loanStatus, "pending");
});

test("no loan without an approved fine for that ticket", async () => {
    const driver = await borrower();
    const res = await askLoan(driver, "TKT-NOPE");
    assert.equal(res.status, 404);
    assert.match(res.body.message, /approved/i);
    assert.equal(await Loan.countDocuments(), 0, "no 0 RWF loan created");
    assert.equal(await Fine.countDocuments(), 0, "no empty fine created");
});

test("eligibility rules are enforced when requesting, not only displayed", async () => {
    const driver = await makeDriver(); // no transaction history
    await approvedFine(driver, "TKT-002", 2000);
    const res = await askLoan(driver, "TKT-002");
    assert.equal(res.status, 403);
    assert.match(res.body.message, /transactions/i);
});

test("one loan at a time; approving twice issues it once", async () => {
    const driver = await borrower();
    await approvedFine(driver, "TKT-003", 1500);
    const { body } = await askLoan(driver, "TKT-003");
    const second = await askLoan(driver, "TKT-003");
    assert.equal(second.status, 403);
    const id = body.data.loan._id;
    const results = await Promise.allSettled([loans.approveLoan(id, driver.user._id), loans.approveLoan(id, driver.user._id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await Transaction.countDocuments({ type: "fine_loan_issued" }), 1);
    const fine = await Fine.findOne({ fineId: "TKT-003" });
    assert.equal(fine.status, "paid");
});

async function activeLoan(driver, amount = 2000) {
    await approvedFine(driver, `TKT-${amount}-${Date.now()}`, amount);
    const fine = await Fine.findOne({ driverId: driver.user._id }).sort({ createdAt: -1 });
    const { body } = await askLoan(driver, fine.fineId);
    return loans.approveLoan(body.data.loan._id, driver.user._id);
}

test("manual repayment needs the money in the wallet and never overdraws it", async () => {
    const driver = await borrower();
    const loan = await activeLoan(driver); // owes 2100
    await fund(driver.user._id, 1000);
    const tooMuch = await request(app).post("/api/loans/repay").set(driver.auth).send({ loanId: loan._id, amount: 2100 });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.message, /Insufficient/);
    const both = await Promise.all([600, 600].map((amount) => request(app).post("/api/loans/repay").set(driver.auth).send({ loanId: loan._id, amount })));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 400], "second 600 RWF can't come out of the 400 RWF left");
    assert.equal((await Wallet.findOne({ driverId: driver.user._id })).balance, 400);
    assert.equal((await Loan.findById(loan._id)).remainingBalance, 1500);
});

test("text amounts are refused and full repayment closes the loan", async () => {
    const driver = await borrower();
    const loan = await activeLoan(driver, 1000); // owes 1050
    await fund(driver.user._id, 5000);
    assert.equal((await request(app).post("/api/loans/repay").set(driver.auth).send({ loanId: loan._id, amount: "abc" })).status, 400);
    const res = await request(app).post("/api/loans/repay").set(driver.auth).send({ loanId: loan._id, amount: 99999 });
    assert.equal(res.status, 200, res.body.message);
    assert.equal(res.body.data.loan.loanStatus, "successful");
    assert.equal(res.body.data.walletBalance, 5000 - 1050, "only what is owed is taken");
});

test("auto-deduction only reduces the loan by what the wallet actually paid", async () => {
    const driver = await borrower();
    const loan = await activeLoan(driver); // owes 2100, 10% of each ride
    await fund(driver.user._id, 0);
    assert.equal(await loans.autoDeductFromRide(String(driver.user._id), 5000), 0, "empty wallet: nothing taken");
    assert.equal((await Loan.findById(loan._id)).remainingBalance, 2100, "loan unchanged when nothing was paid");
    await fund(driver.user._id, 300);
    assert.equal(await loans.autoDeductFromRide(String(driver.user._id), 5000), 300, "takes what is there, up to 10% of the ride");
    assert.equal((await Wallet.findOne({ driverId: driver.user._id })).balance, 0);
    assert.equal((await Loan.findById(loan._id)).remainingBalance, 1800);
});

test("overdue loans can be saved, still repaid, and block new loans", async () => {
    const driver = await borrower();
    const loan = await activeLoan(driver);
    await Loan.updateOne({ _id: loan._id }, { $set: { loanStatus: "overdue" } }, { runValidators: true });
    assert.equal((await Loan.findById(loan._id)).loanStatus, "overdue");
    await fund(driver.user._id, 5000);
    assert.equal(await loans.autoDeductFromRide(String(driver.user._id), 1000), 100);
    await approvedFine(driver, "TKT-NEXT", 1000);
    assert.equal((await askLoan(driver, "TKT-NEXT")).status, 403);
});

test("approval builds the repayment schedule and repayments are recorded on it", async () => {
    const driver = await borrower();
    const loan = await activeLoan(driver); // 2100
    const schedule = await repayments.getSchedule(loan._id);
    assert.ok(schedule, "schedule created on approval");
    assert.equal(schedule.installments.reduce((s, i) => s + i.amount, 0), 2100);
    await fund(driver.user._id, 5000);
    await request(app).post("/api/loans/repay").set(driver.auth).send({ loanId: loan._id, amount: 2100 });
    const after = await repayments.getSchedule(loan._id);
    assert.ok(after.installments.every((i) => i.status === "paid"));
});

test("my-loans returns the driver's loans with their fine", async () => {
    const driver = await borrower();
    await activeLoan(driver);
    const res = await request(app).get("/api/loans/my-loans").set(driver.auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].loanStatus, "active");
    assert.equal(res.body.data[0].remainingBalance, 2100);
});

test("driver finance summary only counts approved loans as outstanding", async () => {
    const driver = await borrower();
    await approvedFine(driver, "TKT-SUM", 2000);
    const { body } = await askLoan(driver, "TKT-SUM");
    const pending = await request(app).get("/api/driver-finance/summary").set(driver.auth);
    assert.equal(pending.body.data.balances.loanOutstanding, 0, "a pending request isn't owed yet");
    await loans.approveLoan(body.data.loan._id, driver.user._id);
    const active = await request(app).get("/api/driver-finance/summary").set(driver.auth);
    assert.equal(active.body.data.balances.loanOutstanding, 2100);
});
