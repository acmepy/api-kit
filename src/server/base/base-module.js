import express from "express";

export class BaseModule {
  #config;
  #model;
  #service;
  #router;
  #schemas;

  constructor({ config, model, service, router, schemas = {} }) {
    this.#config = config;
    this.#model = model;
    this.#service = service;
    this.#router = router;
    this.#schemas = schemas;
  }

  get name() {
    return this.#config.name;
  }

  get basePath() {
    return this.#config.basePath;
  }

  get config() {
    return this.#config;
  }

  get model() {
    return this.#model;
  }

  get service() {
    return this.#service;
  }

  get router() {
    return this.#router;
  }

  get schemas() {
    return this.#schemas;
  }

  mount() {
    const router = express.Router();
    router.use(this.#config.basePath, this.#router.router);
    return router;
  }
}
