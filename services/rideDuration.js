// Old rides may lack start timestamps. Unknown elapsed time must not become NaN.
function rideDuration(ride, now = Date.now()) {
  for (const value of [ride.startedAt, ride.startConfirmedAt]) {
    if (value == null || value === "") continue;
    const start = new Date(value).getTime();
    if (Number.isFinite(start) && start <= now)
      return Math.max(1, Math.round((now - start) / 60000));
  }
  const existing = ride.actualDurationMin;
  return typeof existing === "number" &&
    Number.isFinite(existing) &&
    existing >= 0
    ? existing
    : undefined;
}
module.exports = rideDuration;
