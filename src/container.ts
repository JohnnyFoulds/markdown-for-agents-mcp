/**
 * Dependency injection container
 * Provides centralized management of service instances
 */

import { fetcher } from './fetcher.js';
import { converter } from './converter.js';
import { Logger } from './utils/logger.js';

export class Container {
  private _initialized = false;

  /**
   * Get the fetcher instance
   */
  public getFetcher() {
    return fetcher as unknown as { initialize: () => Promise<void>; close: () => Promise<void> };
  }

  /**
   * Get the converter instance
   */
  public getConverter() {
    return converter as unknown as { convert: (html: string) => string };
  }

  /**
   * Get the logger
   */
  public getLogger() {
    return Logger;
  }

  /**
   * Get all services for destructuring
   */
  public getServices() {
    return {
      fetcher: this.getFetcher(),
      converter: this.getConverter(),
      logger: this.getLogger(),
    };
  }

  /**
   * Initialize all services
   */
  public async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }

    await this.getFetcher().initialize();
    this._initialized = true;
    Logger.info('Container initialized');
  }

  /**
   * Shutdown all services
   */
  public async shutdown(): Promise<void> {
    await this.getFetcher().close();
    this._initialized = false;
    Logger.info('Container shutdown');
  }
}

export const container = new Container();
