export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
export function warn(...args) {
  console.warn(new Date().toISOString(), ...args);
}
export function err(...args) {
  console.error(new Date().toISOString(), ...args);
}
