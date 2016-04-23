'use strict';

const MemoryFileSystem = require("memory-fs");
const webpack = require('webpack');
const fs = require('fs');
const path = require('path');
const process = require('process');
const mkdirp = require('mkdirp');
const Promise = require('bluebird');

let resolver = null,
	log = null,
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

// wait for bundle valid
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
			log('webpack: (watching=' + watching + ') Compilation failed', err)
		} else {
			log('webpack: (watching=' + watching + ') Compilation succeeded')
		}
	}
}


// Load make config
function makeConfig() {
	let configPath = path.resolve(project.custom.webpack.configPath);
	if (!fs.existsSync(configPath)) {
		throw new Error(`Unable to location webpack config path ${configPath}`);
	}

	log(`Making compiler with config path ${configPath}`);


	config = require(configPath);
	config.target = 'node';

	// Output config
	outputPath = path.resolve(process.cwd(),'target');
	if (!fs.existsSync(outputPath))
		mkdirp.sync(outputPath);

	const output = config.output = config.output || {};
	output.library = '[name]';
	output.libraryTarget = 'umd';
	output.filename = '[name].js';
	output.path = outputPath;

	log('Building entry list');
	const entries = config.entry =  {};

	const functions = project.getAllFunctions();
	functions.forEach(fun => {

		// Runtime checks
		// No python or Java :'(
		if (fun.runtime !== 'webpack') {
			log(`${fun.name} is not a webpack function`);
			return
		}


		const handlerParts = fun.handler.split('/').pop().split('.');
		const handlerPath = fun.getRootPath(handlerParts[0]);

		log(`Adding entry ${fun.name} with path ${handlerPath}`);
		entries[fun.name] = [handlerPath];
	});

	log(`Final entry list ${Object.keys(config.entry).join(', ')}`);
}

function invalidPlugin() {
	if(state)
		log("webpack: bundle is now INVALID.");
	// We are now in invalid state
	state = false;
}
function invalidAsyncPlugin(_compiler, callback) {
	invalidPlugin();
	callback();
}

// Load the config
function makeCompiler() {
	if (!config) {
		makeConfig();
	}


	compiler = webpack(config);
	//memoryFileSystem = compiler.outputFileSystem = new MemoryFileSystem();

	log('Initial run');
	compiler.run(makeWebpackCallback(false));
	log('Starting watch');
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
			// var displayStats = (!options.quiet && options.stats !== false);
			// if(displayStats &&
			// 	!(stats.hasErrors() || stats.hasWarnings()) &&
			// 	options.noInfo)
			// 	displayStats = false;
			// if(displayStats) {
			// 	console.log(stats.toString(options.stats));
			// }
			// if (!options.noInfo && !options.quiet)
			console.info("webpack: bundle is now VALID.");

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

const makeResolver = () => {
	log('Making resolver');
	resolver = {
		resolveWhenReady,
		resolve(funName) {
			return new Promise((resolve,reject) => {
				const outputFile = path.resolve(outputPath,`${funName}.js`);
				log(`webpack: resolving ${funName} with ${outputFile}`);

				const doResolve = () => {
					if (!state) {
						return reject(new Error('resolve called on state not ready'));
					}
					log(`webpack: resolving now - ready! - ${outputFile}`);
					const loadedModule = require(outputFile);
					log(`loaded module: ${typeof loadedModule} - ${Object.keys(loadedModule)}`);
					return resolve(loadedModule);
				}

				try {
					resolveWhenReady(doResolve);
				} catch (err) {
					console.error('webpack failed to resolve' + funName,err.stack);
					reject(err)
				}
			});
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


