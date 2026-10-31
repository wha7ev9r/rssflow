import type { AppConfig, Env } from './config';
import type { Db } from './db';

export interface User {
  id: number;
  username: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    cfg: AppConfig;
    user: User;
  };
};
