import type { API } from 'homebridge';
import { DelonghiPlatform, PLATFORM_NAME } from './platform.js';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, DelonghiPlatform);
};
