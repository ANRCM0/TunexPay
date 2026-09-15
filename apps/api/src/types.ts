import type { Application } from "@prisma/client";

export type AppVariables = {
  requestId: string;
  application: Application;
};

export type AppEnv = {
  Variables: AppVariables;
};
