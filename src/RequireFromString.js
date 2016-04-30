const vm = require('vm');
const path = require('path');
const Module = module.constructor;


/**
 * Influenced heavily by require-from-string
 *
 * The major diff is around the parsing/loading
 * of modules.  We use a vm instance,
 * the original functionality referenced non-public
 * Module.prototype._compile
 *
 * @param code - source code to compile
 * @param filename - filename to ref
 * @param opts - opts to pass along
 * @returns {*}
 */
module.exports = function requireFromString(code, filename, opts) {
	if (typeof filename === 'object') {
		opts = filename;
		filename = undefined;
	}

	opts = opts || {};

	opts.appendPaths = opts.appendPaths || [];
	opts.prependPaths = opts.prependPaths || [];

	if (typeof code !== 'string') {
		throw new Error('code must be a string, not ' + typeof code);
	}

	var paths = Module._nodeModulePaths(path.dirname(filename));

	var m = new Module(filename, module.parent);
	m.filename = filename;
	m.paths = [].concat(opts.prependPaths).concat(paths).concat(opts.appendPaths);

	const locals = {
		module:m,
		exports:m.exports,
		__dirname:__dirname,
		__filename:__filename,
		console,
		process,
		require
	};
	vm.runInNewContext(code,locals);
	return m.exports;
};
