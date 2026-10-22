import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=5; CREATE TABLE foreign_data(id INTEGER PRIMARY KEY,payload BLOB)');
const insert=db.prepare('INSERT INTO foreign_data VALUES(?,randomblob(8192))');
db.exec('BEGIN');for(let i=0;i<64;i++)insert.run(i);db.exec('COMMIT');
// Force dirty pages into the main file while their original pages remain in a
// genuine hot rollback journal. Do not close/rollback before crashing.
db.exec('BEGIN IMMEDIATE; UPDATE foreign_data SET payload=zeroblob(8192)');
process.kill(process.pid,'SIGKILL');
