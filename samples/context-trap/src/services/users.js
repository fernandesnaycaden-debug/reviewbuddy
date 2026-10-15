import { db } from '../db.js';

export class NotFoundError extends Error {}

/**
 * Load a user by id. Throws NotFoundError when there is no such user and an Error when
 * the stored name is empty, so callers always get a user with a non-empty name.
 */
export async function getUser(id) {
  const result = await db.query('SELECT id, name, email FROM users WHERE id = $1', [id]);
  const user = result.rows[0];
  if (!user) throw new NotFoundError(`No user ${id}`);
  if (typeof user.name !== 'string' || user.name === '') {
    throw new Error(`User ${id} has no name`);
  }
  return user;
}

export async function listUsers(limit = 50) {
  const result = await db.query('SELECT id, name FROM users ORDER BY id LIMIT $1', [limit]);
  return result.rows;
}

export async function renameUser(id, name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('Name must be a non-empty string');
  }
  await db.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), id]);
}

export async function deleteUser(id) {
  await db.query('DELETE FROM users WHERE id = $1', [id]);
}

export function formatUser(user) {
  return `${user.name} <${user.email}>`;
}

export async function greetingFor(id) {
  const user = await getUser(id);
  return `Hello, ${user.name.toUpperCase()}!`;
}

export function initials(names) {
  const letters = [];
  for (let i = 1; i < names.length; i++) {
    letters.push(names[i].charAt(0).toUpperCase());
  }
  return letters.join('');
}
