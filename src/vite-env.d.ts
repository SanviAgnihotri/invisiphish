/// <reference types="vite/client" />

/**
 * The values Vite writes into the build.
 *
 * Both are constants of the deployment, and both are needed by the browser
 * before it has asked the API anything: the model precision decides which
 * export is loaded, and the Auth service's address is what lets the sign-in
 * page draw the Google button in its first paint.
 */
declare const __INVISIPHISH_QUANTIZED__: string;
declare const __VIGIL_AUTH_BASE_URL__: string;
