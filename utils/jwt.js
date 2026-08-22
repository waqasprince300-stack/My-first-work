const getJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required");
  }

  return "development-jwt-secret-change-me";
};

const getSocketJwtSecret = () =>
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === "production"
    ? null
    : "development-jwt-secret-change-me");

module.exports = {
  getJwtSecret,
  getSocketJwtSecret,
};
