/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest/presets/js-with-ts',
  testEnvironment: 'node',
  automock: false,
  transform: {"\\.(ts|tsx)$": "ts-jest"},
  verbose: true,
  collectCoverage: true,
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.json"
    }
  }
};