'use strict';

const MemoryFileSystem = require("memory-fs");
const webpack = require('webpack');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const Promise = require('bluebird');
const _ = require('lodash');
const requireFromString = require('./RequireFromString');

/**
 * Default options
 *
 * @type {{useMemoryFs: boolean, config: Object, configPath: string}}
 */
const defaultOptions = {
	useMemoryFs: true,
	configPath: 'webpack.config.js',
	config: null
};

const
	CommonJS = 'commonjs',
	CommonJS2 = 'commonjs2';

let options = null,
	resolver = null,
	log = null,
	libraryTarget = CommonJS,
	config = null,
	memoryFileSystem = null,
	outputPath = null,
	S = null,
	project = null,
	compiler = null,
	compilationCallbacks = [];

// the state, false: bundle invalid, true: bundle valid
let state = false;

// in lazy mode, rebuild automatically
let forceRebuild = false;


/**
 * Get the output filesystem where webpack should write to
 *
 * @returns {*}
 */
function getOutputFileSystem() {
	if (options.useMemoryFs) {
		if (!memoryFileSystem) {
			memoryFileSystem = new MemoryFileSystem();
		}
		return memoryFileSystem;
	} else
		return fs;
}

/**
 * Proxy to resolve that will hold
 * all callbacks until the compilation state
 * is ready
 *
 * @param fn
 * @returns {*}
 */
function resolveWhenReady(fn) {
	if(state)
		return fn();

	// if(!options.noInfo && !options.quiet)
	log("webpack: wait until bundle finished: " + (fn.name));

	compilationCallbacks.push(fn);
}


/**
 * Make webpack compilation callback
 *
 * @param watching
 * @returns {compileComplete}
 */
function makeWebpackCallback(watching) {
	return function compileComplete(err,stats) {
		if (err) {
			log(`webpack: (watching=${watching}) Compilation failed: ${stats.toString(config.stats)}`, err);
		} else {
			log(`webpack: (watching=${watching}) Compilation succeeded`);
		}
	}
}

/**
 * Create a the configuration object
 */
function makeConfig() {
	if (config)
		throw new Error('Config can only be created once');

	options = project.custom.webpack || {}
	_.defaultsDeep(options,defaultOptions);

	if (options.config) {
		config = options.config;
	} else {
		let configPath = path.resolve(options.configPath);
		if (!fs.existsSync(configPath)) {
			throw new Error(`Unable to location webpack config path ${configPath}`);
		}

		log(`Making compiler with config path ${configPath}`);
		config = require(configPath);

		if (_.isFunction(config))
			config = config()
	}


	config.target = 'node';

	// Output config
	outputPath = path.resolve(process.cwd(),'target');
	if (!fs.existsSync(outputPath))
		mkdirp.sync(outputPath);

	const output = config.output = config.output || {};
	output.library = '[name]';

	// Ensure we have a valid output target
	if (!_.includes([CommonJS,CommonJS2],output.libraryTarget)) {
		console.warn('Webpack config library target is not in',[CommonJS,CommonJS2].join(','))
		output.libraryTarget = CommonJS2
	}

	// Ref the target
	libraryTarget = output.libraryTarget

	output.filename = '[name].js';
	output.path = outputPath;

	log('Building entry list');
	const entries = config.entry =  {};

	const functions = project.getAllFunctions();
	functions.forEach(fun => {

		// Runtime checks
		// No python or Java :'(

		if (!/node/.test(fun.runtime)) {
			log(`${fun.name} is not a webpack function`);
			return
		}


		const handlerParts = fun.handler.split('/').pop().split('.');
		let modulePath = fun.getRootPath(handlerParts[0]), baseModulePath = modulePath;
		if (!fs.existsSync(modulePath)) {
			for (let ext of config.resolve.extensions) {
				modulePath = `${baseModulePath}${ext}`;
				log(`Checking: ${modulePath}`);
				if (fs.existsSync(modulePath))
					break;
			}
		}

		if (!fs.existsSync(modulePath))
			throw new Error(`Failed to resolve entry with base path ${baseModulePath}`);

		const handlerPath = require.resolve(modulePath);

		log(`Adding entry ${fun.name} with path ${handlerPath}`);
		entries[fun.name] = handlerPath;
	});

	log(`Final entry list ${Object.keys(config.entry).join(', ')}`);
}

function invalidPlugin() {
	if(state)
		log("webpack: bundle is now INVALID.");
	// We are now in invalid state
	state = false;
}

//noinspection JSUnusedLocalSymbols
/**
 * Callback when package is invalidated
 *
 * @param compiler
 * @param callback
 */
function invalidAsyncPlugin(compiler, callback) {
	state = false

	invalidPlugin();
	callback();
}


/**
 * Create the webpack compiler
 */
function makeCompiler() {
	if (!config) {
		makeConfig();
	}

	compiler = webpack(config);
	if (options.useMemoryFs)
		memoryFileSystem = compiler.outputFileSystem = getOutputFileSystem();

	log('webpack: First compilation');
	compiler.run(makeWebpackCallback(false));
	log('webpack: Watching');
	compiler.watch({},makeWebpackCallback(true));


	compiler.plugin("invalid", invalidPlugin);
	compiler.plugin("watch-run", invalidAsyncPlugin);
	compiler.plugin("run", invalidAsyncPlugin);





	compiler.plugin("done", stats => {
		// We are now on valid state
		state = true;


		function continueBecauseBundleAvailable(cb) {
			cb();
		}

		function readyCallback() {
			// check if still in valid state
			if(!state) return;

			log(`webpack compiled ${stats.toString(config.stats || {})}`)

			// print webpack output
			let displayStats = (!options.quiet && config.stats !== false) ||
				stats.hasErrors() || stats.hasWarnings()

			if(displayStats)
				log(stats.toString(options.stats));

			// if (!options.noInfo && !options.quiet)
			log("webpack: bundle is now VALID.");

			// execute callback that are delayed
			var cbs = compilationCallbacks;
			compilationCallbacks = [];
			cbs.forEach(continueBecauseBundleAvailable);
		}

		// Do the stuff in nextTick, because bundle may be invalidated
		//  if a change happened while compiling
		process.nextTick(readyCallback);

		// In lazy mode, we may issue another rebuild
		if(forceRebuild) {
			forceRebuild = false;
			rebuild();
		}
	});
}

function rebuild() {
	if(state) {
		state = false;
		compiler.run(err => {
			if(err) throw err;
		});
	} else {
		forceRebuild = true;
	}
}

/**
 * Create a resolve handler
 *
 * @param funName
 * @returns {function()}
 */
function resolveHandler(funName) {
	return (resolve,reject) => {
		const outputFile = path.resolve(outputPath, `${funName}.js`);
		const srcFile = config.entry[funName];
		log(`webpack: resolving ${funName} with ${outputFile}`);

		function doResolve() {
			if (!state) {
				return reject(new Error('resolve called on state not ready'));
			}

			log(`webpack: resolving now - ready! - ${outputFile}`);


			getOutputFileSystem().readFile(outputFile, (err, data) => {
				if (err) {
					console.error(`Failed to load output content for ${outputFile}`, err.stack);
					return reject(err);
				}

				try {
					const moduleCode = data.toString('utf-8');
					let loadedModule = requireFromString(moduleCode, srcFile);
					if (libraryTarget === CommonJS) {
						const keys = Object.keys(loadedModule);
						log(`CommonJS module: loading ${funName} from module with keys ${keys}`);
						loadedModule = loadedModule[funName];
					}
					return resolve(loadedModule);
				} catch (e) {
					console.error(`Failed to compile/load webpack output: ${outputFile}`, e.stack, e);
					return reject(e);
				}
			});
		}

		try {
			resolveWhenReady(doResolve);
		} catch (err) {
			console.error('webpack failed to resolve' + funName, err.stack);
			reject(err)
		}
	}
}

/**
 * Create resolver
 *
 * @returns {*}
 */
function makeResolver() {
	log('Making resolver');

	resolver = {
		resolveWhenReady,
		resolve(funName) {
			return new Promise(resolveHandler(funName));
		}
	};

	return resolver;
}


module.exports = (_S, _project) => {
	S = _S;
	project = _project;
	log = S.config && S.config.serverlessPath ?
		require(path.join(S.config.serverlessPath, 'utils', 'cli')).log :
		console.log.bind(null, 'Serverless:');



	makeCompiler();

	return makeResolver();
}


