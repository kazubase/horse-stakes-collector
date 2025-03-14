declare module '../db/db.js' {
  import { DrizzleClient } from 'drizzle-orm/neon-serverless';
  import * as schema from '../db/schema.js';
  
  export const db: DrizzleClient<typeof schema>;
  export { schema };
}

declare module './db.js' {
  import { DrizzleClient } from 'drizzle-orm/neon-serverless';
  import * as schema from './schema.js';
  
  export const db: DrizzleClient<typeof schema>;
  export { schema };
} 