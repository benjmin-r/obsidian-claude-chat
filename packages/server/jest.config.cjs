module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	roots: ["<rootDir>/src", "<rootDir>/tests"],
	testMatch: ["**/*.test.ts"],
	moduleFileExtensions: ["ts", "js", "json"],
	transform: {
		"^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
	},
	moduleNameMapper: {
		"^@occ/protocol$": "<rootDir>/../protocol/src/index.ts",
	},
	collectCoverageFrom: [
		"src/**/*.ts",
		"!src/index.ts",
		"!src/sdk-adapter.ts",
		"!src/ports.ts",
		"!src/ws-transport.ts",
	],
	coverageThreshold: {
		global: {
			branches: 80,
			functions: 80,
			lines: 80,
			statements: 80,
		},
	},
};
