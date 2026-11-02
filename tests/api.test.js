process.env.JWT_EXPIRES_IN = "1d";
process.env.JWT_SECRET = "test-secret";
process.env.NODE_ENV = "test";
const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../app");
const User = require("../models/User");
const Provider = require("../models/Provider");
const Service = require("../models/Service");
const Category = require("../models/Category");
const ProviderService = require("../models/ProviderService");
const Booking = require("../models/Booking");
const generateToken = require("../utils/generateToken");

const auth = (t) => ({ Authorization: "Bearer " + t });
let n = 0;
const mk = async (role, extra = {}) => {
  n++;
  const user = await User.create({ name: role + n, email: `${role}${n}@t.com`, phone: "9999999999", password: "Passw0rd!", role, ...extra });
  return { user, token: generateToken(user) };
};
const futureWed = () => {
  const d = new Date(); d.setDate(d.getDate() + 8);
  while (d.getDay() !== 3) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0); return d;
};
let ctx;
async function seed() {
  const customer = await mk("customer"), pu = await mk("provider"), admin = await mk("admin");
  const cat = await Category.create({ name: "Plumbing" + n });
  const service = await Service.create({ name: "Tap Repair", description: "Fix taps", category: cat._id, price: 599, duration: 60 });
  const provider = await Provider.create({ user: pu.user._id, businessName: "Raj Plumbers", phone: "9999999999", address: "Boring Road", city: "Patna", state: "Bihar", pincode: "800001", isVerified: true, isAvailable: true });
  const ps = await ProviderService.create({ provider: provider._id, service: service._id, price: 700, duration: 60 });
  const body = (o = {}) => ({ provider: provider._id, service: service._id, providerService: ps._id, bookingDate: futureWed().toISOString(), address: "12 Main Rd", city: "Patna", state: "Bihar", ...o });
  return { customer, pu, admin, provider, service, ps, body };
}
beforeAll(async () => { await mongoose.connect(process.env.TEST_MONGO_URL); });
beforeEach(async () => { await mongoose.connection.dropDatabase(); ctx = await seed(); });
afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

describe("AUTH (I01-I03, E01, E05)", () => {
  const u = { name: "Asha", email: "asha@t.com", phone: "9876543210", password: "Passw0rd!" };
  test("I01 register returns 201 + token", async () => {
    const r = await request(app).post("/api/auth/register").send(u);
    expect(r.status).toBe(201); expect(r.body.token).toBeDefined();
  });
  test("SEC-01 register response must not expose password hash", async () => {
    const r = await request(app).post("/api/auth/register").send(u);
    expect(JSON.stringify(r.body)).not.toMatch(/\$2[aby]\$/);
  });
  test("SEC-02 login response must not expose password hash", async () => {
    await request(app).post("/api/auth/register").send(u);
    const r = await request(app).post("/api/auth/login").send({ email: u.email, password: u.password });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/\$2[aby]\$/);
  });
  test("I02 duplicate email rejected", async () => {
    await request(app).post("/api/auth/register").send(u);
    const r = await request(app).post("/api/auth/register").send(u);
    expect(r.status).toBe(400);
  });
  test("I03 wrong password 401", async () => {
    await request(app).post("/api/auth/register").send(u);
    const r = await request(app).post("/api/auth/login").send({ email: u.email, password: "bad" });
    expect(r.status).toBe(401);
  });
  test("E01 empty body 400", async () => {
    expect((await request(app).post("/api/auth/register").send({})).status).toBe(400);
    expect((await request(app).post("/api/auth/login").send({})).status).toBe(400);
  });
  test("E05 NoSQL injection login blocked", async () => {
    await request(app).post("/api/auth/register").send(u);
    const r = await request(app).post("/api/auth/login").send({ email: { $ne: "" }, password: { $ne: "" } });
    expect(r.status).not.toBe(200);
  });
  test("SEC-03 public register cannot create admin", async () => {
    const r = await request(app).post("/api/auth/register").send({ ...u, role: "admin" });
    expect(r.body.user.role).not.toBe("admin");
  });
});

describe("ACCESS CONTROL (I04, I05, U10-U13)", () => {
  test("I04 no token 401", async () => { expect((await request(app).get("/api/bookings/my")).status).toBe(401); });
  test("U11 malformed token 401", async () => {
    expect((await request(app).get("/api/bookings/my").set(auth("abc.def.ghi"))).status).toBe(401);
  });
  test("I05 customer blocked from admin dashboard 403", async () => {
    expect((await request(app).get("/api/admin/dashboard").set(auth(ctx.customer.token))).status).toBe(403);
  });
  test("provider blocked from admin dashboard 403", async () => {
    expect((await request(app).get("/api/admin/dashboard").set(auth(ctx.pu.token))).status).toBe(403);
  });
  test("customer blocked from provider booking list 403", async () => {
    expect((await request(app).get("/api/bookings/provider/my").set(auth(ctx.customer.token))).status).toBe(403);
  });
  test("deactivated account blocked 403", async () => {
    await User.findByIdAndUpdate(ctx.customer.user._id, { isActive: false });
    expect((await request(app).get("/api/bookings/my").set(auth(ctx.customer.token))).status).toBe(403);
  });
});

describe("BOOKINGS (I08-I14, E07-E09, FR06)", () => {
  const book = (o) => request(app).post("/api/bookings").set(auth(ctx.customer.token)).send(ctx.body(o));
  test("I08/I09 creates pending booking using SERVER price", async () => {
    const r = await book({ price: 1 });
    expect(r.status).toBe(201);
    const b = await Booking.findOne();
    expect(b.status).toBe("pending"); expect(b.price).toBe(700);
  });
  test("E01 missing required fields 400", async () => {
    const r = await request(app).post("/api/bookings").set(auth(ctx.customer.token)).send({});
    expect(r.status).toBe(400);
  });
  test("E07 past date rejected 400", async () => {
    expect((await book({ bookingDate: "2020-01-01T10:00:00Z" })).status).toBe(400);
  });
  test("E08 unknown service 404", async () => {
    expect((await book({ service: new mongoose.Types.ObjectId() })).status).toBe(404);
  });
  test("I10 provider not available => 404", async () => {
    await Provider.findByIdAndUpdate(ctx.provider._id, { isAvailable: false });
    expect((await book()).status).toBe(404);
  });
  test("E10 overlapping slot 409", async () => {
    expect((await book()).status).toBe(201);
    expect((await book()).status).toBe(409);
  });
  test("I11 provider sees the booking; admin dashboard counts it", async () => {
    await book();
    const p = await request(app).get("/api/bookings/provider/my").set(auth(ctx.pu.token));
    expect(p.status).toBe(200);
    expect(JSON.stringify(p.body)).toMatch(/pending/);
    const a = await request(app).get("/api/admin/dashboard").set(auth(ctx.admin.token));
    expect(a.status).toBe(200);
  });
  test("I12 provider accepts; second accept 400", async () => {
    await book();
    const id = (await Booking.findOne())._id;
    const a1 = await request(app).put(`/api/bookings/provider/${id}/accept`).set(auth(ctx.pu.token));
    expect(a1.status).toBe(200);
    expect((await Booking.findById(id)).status).toBe("accepted");
    const a2 = await request(app).put(`/api/bookings/provider/${id}/accept`).set(auth(ctx.pu.token));
    expect(a2.status).toBe(400);
  });
  test("I13 another provider cannot accept", async () => {
    await book();
    const id = (await Booking.findOne())._id;
    const other = await mk("provider");
    await Provider.create({ user: other.user._id, businessName: "Other", phone: "9999999999", address: "x", city: "Patna", state: "Bihar", pincode: "800001" });
    const r = await request(app).put(`/api/bookings/provider/${id}/accept`).set(auth(other.token));
    expect([403, 404]).toContain(r.status);
    expect((await Booking.findById(id)).status).toBe("pending");
  });
  test("I14 provider cannot jump to invalid status", async () => {
    await book();
    const id = (await Booking.findOne())._id;
    const r = await request(app).put(`/api/bookings/provider/${id}/status`).set(auth(ctx.pu.token)).send({ status: "banana" });
    expect(r.status).toBe(400);
  });
  test("I14b provider cannot complete a still-PENDING booking", async () => {
    await book();
    const id = (await Booking.findOne())._id;
    const r = await request(app).put(`/api/bookings/provider/${id}/status`).set(auth(ctx.pu.token)).send({ status: "completed" });
    expect(r.status).toBe(400);
  });
  test("customer can cancel own pending booking", async () => {
    await book();
    const id = (await Booking.findOne())._id;
    const r = await request(app).put(`/api/bookings/${id}/cancel`).set(auth(ctx.customer.token)).send({ cancellationReason: "changed mind" });
    expect(r.status).toBe(200);
    expect((await Booking.findById(id)).status).toBe("cancelled");
  });
  test("other customer cannot read my booking", async () => {
    await book();
    const id = (await Booking.findOne())._id;
    const other = await mk("customer");
    const r = await request(app).get(`/api/bookings/${id}`).set(auth(other.token));
    expect(r.status).toBeGreaterThanOrEqual(403);
  });
  test("E18 invalid ObjectId does not return 500", async () => {
    const r = await request(app).get("/api/bookings/123").set(auth(ctx.customer.token));
    expect(r.status).toBeLessThan(500);
  });
});

describe("ADMIN & PLATFORM (I06, I18, E17)", () => {
  test("admin dashboard returns data (T08)", async () => {
    const r = await request(app).get("/api/admin/dashboard").set(auth(ctx.admin.token));
    expect(r.status).toBe(200);
  });
  test("I06 GET /api/admin/settings is reachable for admin (Phase 3 §5.3 contract)", async () => {
    const r = await request(app).get("/api/admin/settings").set(auth(ctx.admin.token));
    expect(r.status).toBe(200);
  });
  test("I05b customer blocked from /api/admin/settings", async () => {
    const r = await request(app).get("/api/admin/settings").set(auth(ctx.customer.token));
    expect(r.status).toBe(403);
  });
  test("T02 health route", async () => {
    const r = await request(app).get("/");
    expect(r.body.success).toBe(true);
  });
  test("I18 unknown route returns JSON 404", async () => {
    const r = await request(app).get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toMatch(/json/);
  });
  test("E17 malformed JSON body gives 400 not 500", async () => {
    const r = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{bad");
    expect(r.status).toBe(400);
  });
  test("public services list works", async () => {
    const r = await request(app).get("/api/services");
    expect(r.status).toBe(200);
  });
});
