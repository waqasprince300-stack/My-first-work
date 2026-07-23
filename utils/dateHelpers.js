const parseDateValue = (value) => {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const ymd = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(raw);
  if (ymd) {
    const date = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toDateOrNull = (value) => parseDateValue(value);
const toDateOrNow = (value) => parseDateValue(value) || new Date();
const toIsoDateString = (value) => {
  const date = parseDateValue(value);
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

module.exports = {
  parseDateValue,
  toDateOrNull,
  toDateOrNow,
  toIsoDateString,
};
