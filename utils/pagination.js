const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function parsePaginationQuery(req, defaultLimit = DEFAULT_LIMIT) {
  const hasPage = req.query.page != null || req.query.limit != null;
  if (!hasPage) {
    return { paginate: false };
  }
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(String(req.query.limit || String(defaultLimit)), 10) || defaultLimit),
  );
  return {
    paginate: true,
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function paginatedJson(res, items, total, page, limit) {
  const totalPages = Math.max(1, Math.ceil(total / limit) || 1);
  return res.json({
    items,
    total,
    page,
    limit,
    totalPages,
  });
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parsePaginationQuery,
  paginatedJson,
};
