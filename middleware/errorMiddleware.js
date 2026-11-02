const errorHandler = (err, req, res, next) => {
  console.error("Global Error:", err);

  // Prefer the status carried by the error (e.g. body-parser sets 400 for bad JSON),
  // then a non-200 status already set on the response, otherwise 500.
  const errStatus = err.statusCode || err.status;
  const statusCode =
    errStatus >= 400 && errStatus < 600
      ? errStatus
      : res.statusCode === 200
        ? 500
        : res.statusCode;

  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
};

module.exports = errorHandler;
