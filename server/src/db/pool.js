import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export const query = (text, params) => pool.query(text, params);

/** pgvector expects a string like "[0.1,0.2,...]" */
export const toVector = (arr) => `[${arr.join(',')}]`;
