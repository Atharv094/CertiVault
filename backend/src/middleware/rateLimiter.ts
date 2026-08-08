import rateLimit from "express-rate-limit";
import { Request, Response } from "express";
import { getEnv } from "../config/env.js";

const env = getEnv();

/**
 * Global API rate limiter applied to all /api routes
 */
export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests, please try again later.",
      },
      requestId: req.id,
    });
  },
});

/**
 * Strict rate limiter applied to authentication routes
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "AUTH_RATE_LIMIT_EXCEEDED",
        message: "Too many authentication attempts, please try again later.",
      },
      requestId: req.id,
    });
  },
});

/**
 * Rate limiter specifically for document/file upload routes to prevent DoS
 */
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 uploads per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "UPLOAD_RATE_LIMIT_EXCEEDED",
        message: "Too many file upload attempts, please try again later.",
      },
      requestId: req.id,
    });
  },
});
