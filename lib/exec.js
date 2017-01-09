// Copyright (c) 2012-2017, Matt Godbolt
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

var child_process = require('child_process'),
    path = require('path'),
    logger = require('./logger').logger;

function execute(command, args, options) {
    options = options || {};
    var maxOutput = options.maxOutput || 1024 * 1024;
    var timeoutMs = options.timeoutMs || 0;
    var env = options.env;

    if (options.wrapper) {
        args.unshift(command);
        command = options.wrapper;
    }

    var okToCache = true;
    logger.debug({type: "executing", command: command, args: args});
    var child = child_process.spawn(command, args, {
        env: env,
        detached: process.platform == 'linux'
    });
    var killChild = options.killChild || function () {
            child.kill();
        };
    var stderr = "";
    var stdout = "";
    var timeout;
    if (timeoutMs)
        timeout = setTimeout(function () {
            okToCache = false;
            killChild();
            stderr += "\nKilled - processing time exceeded";
        }, timeoutMs);
    var truncated = false;
    child.stdout.on('data', function (data) {
        if (truncated) return;
        if (stdout.length > maxOutput) {
            stdout += "\n[Truncated]";
            truncated = true;
            killChild();
            return;
        }
        stdout += data;
    });
    child.stderr.on('data', function (data) {
        if (truncated) return;
        if (stderr.length > maxOutput) {
            stderr += "\n[Truncated]";
            truncated = true;
            killChild();
            return;
        }
        stderr += data;
    });
    child.on('exit', function (code) {
        logger.debug({type: 'exited', code: code});
        if (timeout !== undefined) clearTimeout(timeout);
    });
    return new Promise(function (resolve, reject) {
        child.on('error', function (e) {
            logger.debug("Error with " + command + " args", args, ":", e);
            reject(e);
        });
        child.on('close', function (code) {
            if (timeout !== undefined) clearTimeout(timeout);
            var result = {
                code: code,
                stdout: stdout,
                stderr: stderr,
                okToCache: okToCache
            };
            logger.debug({type: "executed", command: command, args: args, result: result});
            resolve(result);
        });
        if (options.input) child.stdin.write(options.input);
        child.stdin.end();
    });
}

function sandbox(command, args, options) {
    var execPath = path.dirname(command);
    var execName = path.basename(command);
    logger.info("Sandbox execution", command, args);
    return new Promise(function (resolve, reject) {
        logger.debug("Starting sandbox docker container for", command, args);
        var containerId = null;
        var killed = false;
        var timeoutMs = options.timeoutMs || 0;

        function removeContainer() {
            if (containerId) {
                logger.debug("Removing container", containerId);
                execute("docker", ["rm", containerId]);
            } else {
                logger.debug("No container to remove");
            }
        }

        // Start the docker container and detach...
        execute(
            "docker",
            [
                "run",
                "--detach",
                "--cpu-shares=128",
                "--cpu-quota=25000",
                "--network=none",
                "--memory=128M",
                "--memory-swap=0",
                "-v" + execPath + ":/home/ce-user:ro",
                "mattgodbolt/gcc-explorer:exec",
                "./" + execName
            ].concat(args),
            {})
            .then(function (result) {
                if (result.code !== 0) {
                    logger.error("Failed to start docker", result);
                    reject(result);
                    return;
                }
                containerId = result.stdout.trim();
                logger.debug("Docker container id is", containerId);
            })
            .then(function () {
                return execute(
                    "docker",
                    [
                        "wait",
                        containerId
                    ],
                    {
                        timeoutMs: timeoutMs,
                        killChild: function () {
                            logger.debug("Killing docker container", containerId);
                            execute("docker", ["kill", containerId]);
                            killed = true;
                        }
                    });
            })
            .then(function (result) {
                if (result.code !== 0) {
                    logger.error("Failed to wait for", containerId);
                    removeContainer();
                    reject(result);
                    return;
                }
                var returnValue = parseInt(result.stdout);
                return execute(
                    "docker",
                    [
                        "logs",
                        containerId
                    ], options)
                    .then(function (logResult) {
                        if (logResult.code !== 0) {
                            logger.error("Failed to get logs for", containerId);
                            removeContainer();
                            reject(logResult);
                            return;
                        }
                        if (killed)
                            logResult.stdout += "\n### Killed after " + timeoutMs + "ms";
                        logResult.code = returnValue;
                        return logResult;
                    });
            })
            .then(function (result) {
                removeContainer();
                resolve(result);
            })
            .catch(function (err) {
                removeContainer();
                reject(err);
            });
    });
}

module.exports = {
    execute: execute,
    sandbox: sandbox
};