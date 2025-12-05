
import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const dbConfig = {
  server: process.env.DB_SERVER,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true, // Use this if you're on Azure
    trustServerCertificate: true // Change to true for local dev / self-signed certs
  }
};

let pool;
let initializationPromise;

async function connect() {
  if (pool) {
    return pool;
  }
  try {
    pool = await sql.connect(dbConfig);
    return pool;
  } catch (err) {
    console.error('Database Connection Failed! Bad Config: ', err);
    throw err;
  }
}

async function createTable() {
    const db_pool = await connect();
    const request = db_pool.request();
    const tableExistsQuery = `
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='OperationLogs' and xtype='U')
      CREATE TABLE OperationLogs (
        id INT PRIMARY KEY IDENTITY(1,1),
        timestamp DATETIME NOT NULL DEFAULT GETDATE(),
        level NVARCHAR(50) NOT NULL,
        message NVARCHAR(MAX) NOT NULL
      )
    `;
    try {
      await request.query(tableExistsQuery);
      console.log('Table OperationLogs is ready');
    } catch (err) {
      console.error('Error creating table: ', err);
    }
}

async function initialize() {
    if (!initializationPromise) {
        initializationPromise = createTable();
    }
    return initializationPromise;
}

async function log(level, message) {
  try {
    await initialize();
    const db_pool = await connect();
    const request = db_pool.request();
    const logQuery = `
      INSERT INTO OperationLogs (level, message)
      VALUES (@level, @message)
    `;
    request.input('level', sql.NVarChar, level);
    request.input('message', sql.NVarChar, message);
    await request.query(logQuery);
  } catch (err) {
    console.error('Error writing to log: ', err);
  }
}

export { log, initialize };
