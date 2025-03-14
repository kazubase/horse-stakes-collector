module.exports = {
  apps: [{
    name: 'odds-collector',
    script: './node_modules/.bin/tsx',
    args: 'src/db/daily-odds-collector.ts',
    interpreter: 'node',
    interpreter_args: '-r dotenv/config',
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: process.env.DATABASE_URL,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY
    },
    env_development: {
      NODE_ENV: 'development',
      DATABASE_URL: process.env.DATABASE_URL,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY
    },
    output: './logs/odds-collector-out.log',
    error: './logs/odds-collector-error.log',
    time: true,
    max_size: '10M',
    rotate_interval: '1d',
    retain: '7',
  }]
}; 
