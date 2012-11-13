"use strict";

/**
 * Run Process Manager
 *
 * Manages all running subprocesses. Takes care of executing/spawning them, keeps
 * a list of running processes that keeps synced with the client, and contains
 * some utility functions such as `ps` or `kill` to deal with operations on processes
 *
 *
 */

var async = require("asyncjs");
var Plugin = require("../cloud9.core/plugin");
var c9util = require("../cloud9.core/util");
var util = require("util");
var Path = require("path");

var name = "run";
var VFS;

module.exports = function (options, imports, register) {
    VFS = imports.vfs;
    imports.ide.register(name, RunPlugin, register);
};

var RunPlugin = function (ide, workspace) {
    Plugin.call(this, ide, workspace);

    this.ide = ide;
    this.vfs = VFS;
    this.workspaceId = workspace.workspaceId;
    this.workspaceDir = ide.workspaceDir;
    this.hooks = ["command"];
    this.processes = {};
    this.name = name;
};

util.inherits(RunPlugin, Plugin);

(function() {
    this.command = function(user, message, client) {
        if (message && message.type === "run") {
            this.exec(message);
        }
    };

    this.exec = function (message) {
        var self = this;
        this.createChild(message.line, message, function(err, process) {
            if (err) {
                self.send({
                    type: "error",
                    err: err,
                    command: message.type,
                    uniqueId: message.uniqueId
                });
            }
        });
    };

    /**
     * Sends out the current list of processes to the client, in order to have a
     * synchronized list.
     *
     * @param [subtype] Extra information about the nature of the operation
     * @return {Void}
     */
    this.updateProcessList = function(subtype) {
        var processes = this.processes
        var fullPidList = Object.keys(processes).map(function(pid) {
            return { pid: pid, ideRun: processes[pid].ideRun };
        });

        // Synchronize process list with the client.
        self.send({
            type: "processlist",
            subtype: subtype || "",
            pid: meta && meta.process && meta.process.pid,
            list: fullPidList
        });
    };

    /**
     * Spawns a new process and attaches events to its stream of data if succesful.
     *
     * @param {String} cmd Command line command to spawn
     * @param {Object} runOptions Extra configuration options
     * @param {Function} callback Function to execute after spawning
     * @returns {Void}
     */
    this.createChild = function(cmd, runOptions, callback) {
        var self = this;
        this.vfs.spawn(cmd, runOptions, function(err, meta) {
            if (err) return callback(err);
            if (!meta.process)
                return callback(new Error("No process metadata returned"));

            self.processes[meta.process.pid] = meta.process;

            self.updateProcessList("add");
            self.attachEvents(runOptions, meta.process);
            callback(err, meta.process);
        });
    };

    /**
     * Attaches events to a running process and sends them to the client. It ends
     * up sending `start`, `end`, `stderr` and `stdout` events.
     *
     * @param {Object} runOptions Configuration options
     * @param {Object} child Process to attach events to
     * @returns {Void}
     */
    this.attachEvents = function(runOptions, child) {
        var self = this;
        var type = runOptions.type;
        var pid = child.pid;

        child.stdout.on("data", sender("stdout"));
        child.stderr.on("data", sender("stderr"));

        function send(obj) {
            self.send(c9util.extend(obj, {
                command: "run-shell",
                extra: runOptions,
                pid: pid
            }));
        }

        function sender(stream) {
            return function(data) {
                send({
                    "type": type + "-data",
                    "stream": stream,
                    "data": data.toString()
                });
            };
        }

        child.on("exit", function(code) {
            pid = 0;
            send({
                "type": type + "-exit",
                "code": code
            });
        });

        process.nextTick(function() { send({ "type": type + "-start" }); });
    };

    this.destroy = function() {
        this.disposed = true;
        clearInterval(this.shutDownInterval);

        var ps = this.ps();
        Object.keys(ps).forEach(this.kill.bind(this));
    };

    this.prepareShutdown = function(callback) {
        var self = this;
        var processCount;

        console.log(this.workspaceId + ": Waiting for child process to finish.");

        // wait for all child processes to finish
        this.shutDownInterval = setInterval(function() {
            processCount = Object.keys(self.ps()).length;

            if (!processCount)
                return callback();
        }, 100);
    };

    this.ps = function() {
        var list = {};

        for (var pid in this.processes) {
            var child = this.processes[pid];

            // process has exited
            if (!child.pid || child.killed) {
                delete this.processes[pid];
            }
            else {
                list[pid] = child.describe();
                list[pid].extra = child.extra;
            }
        }

        return list;
    };

    this.debug = function(pid, debugMessage, callback) {
        var child = this.processes[pid];
        if (!child || !child.pid)
            return callback("Process is not running: " + pid);

        if (!child.debugCommand)
            return callback("Process does not support debugging: " + pid);

        child.debugCommand(debugMessage);
        callback();
    };

    this.kill = function(pid, callback) {
        if (typeof callback !== "function") {
            callback = function() {};
        }

        var child = this.processes[pid];
        if (!child)
            return callback("Process does not exist");

        child.killed = true;
        child.kill("SIGKILL");
        callback();
    };

    this._isDir = function(stat) {
        return (
            stat.mime == "inode/directory" ||
            (stat.linkStat && stat.linkStat.mime == "inode/directory")
        );
    };

    // VFS wrappers
    this.internal_isfile = function(message) {
        var file  = message.argv.pop();
        var path  = message.cwd || this.workspaceDir;
        var self = this;

        path = Path.normalize(path + "/" + file.replace(/^\//g, ""));

        if (path.indexOf(this.workspaceDir) === -1) {
            this.sendResult();
            return;
        }

        this.vfs.stat(message.path, message.options || {}, function(err, stat) {
            if (err || stat.err) {
                return self.sendResult(0, "error", {
                    errmsg: "Problem opening file; it does not exist or something else failed. More info: " +
                        err.toString().replace("Error: ENOENT, ", ""),
                    extra: message.extra
                });
            }

            self.sendResult(0, "internal-isfile", {
                cwd: message.path,
                isfile: (stat && !self._isDir(stat)),
                sender: message.sender || "shell",
                extra: message.extra
            });
        });
    };
}).call(RunPlugin.prototype);