const UNSAFE_SHELL_ENV_NAMES = new Set(["BASH_ENV", "ENV"]);

export function withoutShellStartupAuthority(
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const sanitized = { ...env };
	for (const name of Object.keys(sanitized)) {
		if (
			UNSAFE_SHELL_ENV_NAMES.has(name) ||
			(name.startsWith("BASH_FUNC_") && name.endsWith("%%"))
		)
			delete sanitized[name];
	}
	return sanitized;
}

export function processGateEnvironment(
	source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin:/bin",
		LC_ALL: "C",
		LANG: "C",
		...(source.TMPDIR === undefined ? {} : { TMPDIR: source.TMPDIR }),
		...(source.TMP === undefined ? {} : { TMP: source.TMP }),
		...(source.TEMP === undefined ? {} : { TEMP: source.TEMP }),
		...(source.SYSTEMROOT === undefined
			? {}
			: { SYSTEMROOT: source.SYSTEMROOT }),
	};
}
