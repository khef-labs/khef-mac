-- Migration: Increase max file size to 5GB for local video uploads
-- Created: 2026-02-23T22:10:15Z

-- UP
UPDATE settings SET value = '5120', description = 'Maximum file size in MB (5GB)' WHERE key = 'files.maxSizeMb';

-- DOWN
UPDATE settings SET value = '10', description = 'Maximum file size in MB' WHERE key = 'files.maxSizeMb';
