var fs = require('fs');

var port = 8080, lockFile = __dirname + '/lock.pid', pid, doStop = process.argv[2] == 'stop';
if(!doStop)
    var express = require('express'), app = express(), execFile = require('child_process').execFile, server = require('http').createServer(app), io = require('socket.io').listen(server);

// "Daemon"-like system.
// FIXME simplify and DRY the logic here.
try {
    pid = +fs.readFileSync(lockFile, 'utf8');
    pid = !isNaN(pid) && pid;
} catch(e) {}

function done() {
    process.on('exit', function() {
        if(fs.existsSync(lockFile))
            fs.unlinkSync(lockFile);
    });
    process.on('SIGTERM', process.exit.bind(process, 0));
    process.on('SIGHUP', function() {
        console.error('Ignoring SIGHUP');
    });
    if(!doStop) {
        server.listen(port);
        fs.writeFileSync(lockFile, ''+process.pid);
    } else
        process.exit();
}

if(pid) {
    // Try to kill the old process.
    try {
        process.kill(pid);
    } catch(e) {}
}
if(pid) {
    var failTimeout = setTimeout(function() {
        console.error('Error: old wIDE instance not exiting or stale lock.pid. If wIDE is no longer running, try removing lock.pid first.');
        process.exit(1);
    }, 2000);
    try {
        var watcher = fs.watch(lockFile, {persistent: false}, function() {
            if(!fs.existsSync(lockFile))
                clearTimeout(failTimeout), watcher.close(), done();
        });
    } catch(e) {
        if(e.code != 'ENOENT')
            throw e;
        clearTimeout(failTimeout), done();
    }
} else
    done();

if(doStop)
    return;

function xdgMime(path, cb) {
    // HACK right now the only mimetype set that has consistent icons and syntax highlighting
    // is KDE's, with Oxygen for icons and Kate (via KateSyntax.js) for syntax highlighting.
    // If you have another solution, please add a new issue at https://github.com/eddyb/wIDE/issues/new
    var env = {};
    for(var i in process.env)
        env[i] = process.env[i];
    env.XDG_CURRENT_DESKTOP = 'KDE';
    execFile('xdg-mime', ['query', 'filetype'].concat([Array.isArray(path) ? path : [path]]), {env: env}, function (err, stdout) {
        stdout = stdout.trim();
        if (err) {
            if (stdout)
                err.message = stdout;
            cb(err);
        } else
            cb(null, Array.isArray(path) ? stdout.split('\n') : stdout);
    });
};

app.configure(function() {
    app.use(express.methodOverride());
    app.use(express.bodyParser());
    app.use(express.static(__dirname + '/static'));
    app.use(express.errorHandler({dumpExceptions: true, showStack: true}));
    app.use(app.router);
});

/*app.get('/', function(req, res) {
    res.sendfile(__dirname + '/index.html');
});*/

io.set('log level', 2);
io.set('browser client minification', true);

var config = require('./config');

var userManager = require('./lib/userManager');
userManager.basePath = config.userDir;

var modules = (config.modules || []).map(function(name) {
    var module = require(config.moduleDir+'/'+name);
    if(module.load)
        module.load(app, express);
    return module;
});

io.sockets.on('connection', function(socket) {
    socket.on('login', function(user, password, callback) {
        var data = userManager.login(user, password);
        if(!data)
            return callback('<b>Login failed</b> user/password don\'t match!');
        socket.user = data;

        socket.on('project.list', function(callback) {
            callback(socket.user.projects.map(function(project) {return project.name;}));
        });

        //!TODO Check for path tricks.
        socket.on('file.list', function(project, dir, callback) {
            //if(socket.user.projects.indexOf(project) === -1)
            //    return;
            var path = userManager.path(socket.user.name) + '/projects/' + project + '/' + (dir ? dir + '/' : '');
            fs.readdir(path, function(err, files) {
                if(err)
                    return console.error(err);
                callback(files.map(function(file) {
                    return [file, fs.statSync(path + file).isDirectory()];
                }));
            });
        });

        socket.on('file.mime', function(project, file, callback) {
            //if(socket.user.projects.indexOf(project) === -1)
            //    return;
            xdgMime(userManager.path(socket.user.name) + '/projects/' + project + '/' + file, function(err, mime) {
                if(err)
                    return console.error(err);
                callback(mime.replace(/;.*$/, ''));
            });
        });

        socket.on('file.read', function(project, file, callback) {
            //if(socket.user.projects.indexOf(project) === -1)
            //    return;
            fs.readFile(userManager.path(socket.user.name) + '/projects/' + project + '/' + file, 'utf8', function(err, data) {
                if(err)
                    return console.error(err);
                callback(data);
            });
        });

        socket.on('file.write', function(project, file, data, callback) {
            //if(socket.user.projects.indexOf(project) === -1)
            //    return;
            fs.writeFile(userManager.path(socket.user.name) + '/projects/' + project + '/' + file, data, function(err) {
                if(err)
                    return console.error(err);
                callback();
            });
        });

        // Enable all the modules for this user.
        // TODO per-user module management.
        // TODO module disabling.
        var ref = 0;
        socket.deferLoading = function deferLoading(cb) {
            ref++;
            var derefd = false;
            return function(unused) { // Unused argument so socket.io doesn't end up throwing the function away.
                if(!derefd) {
                    derefd = true;
                    if(cb)
                        cb();
                    if(!--ref)
                        callback();
                }
            };
        }

        socket.loadScript = function loadScript(src, cb) {
            socket.emit('loadScript', src, socket.deferLoading(cb));
        };

        socket.loadScriptES6 = function loadScriptES6(src, cb) {
            socket.emit('loadScriptES6', src, socket.deferLoading(cb));
        };

        modules.forEach(function(module) {
            if(module.enable)
                module.enable(socket);
        });

        if(!ref)
            callback();
    });
});
