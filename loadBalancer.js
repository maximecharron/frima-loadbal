var http = require('http');
var proxy = require('http-proxy');
var request = require('request');
var lastServer = -1;
http.globalAgent.maxSockets = 10240;
var port = process.env.PORT || 2000;


var servers = [
    'http://frima-server-1.herokuapp.com',
    'http://frima-server-2.herokuapp.com',
    'http://frima-server-3.herokuapp.com',
    'http://frima-server-4.herokuapp.com'
];
var failoverTimer = [];

var proxies = [];

function createProxies(){
    servers.forEach(function(server){
        var proxyServer = new proxy.createProxyServer({
            target: server,
            ws: true,
            xfwd: true,
            down: false,
            prependPath: false
        });
        proxies.push(proxyServer);
    })
};

createProxies();

var selectServer = function (req, res)
{
    var index = -1;
    var i = 0;

    // Check if there are any cookies to find the server already used if it is a returning connection
    if (req.headers && req.headers.cookie && req.headers.cookie.length > 1)
    {
        var cookies = req.headers.cookie.split('; ');
        for (i = 0; i < cookies.length; i++)
        {
            if (cookies[i].indexOf('server=') === 0)
            {
                var value = cookies[i].substring(7, cookies[i].length);
                if (value && value !== '')
                {
                    index = value;
                    break;
                }
            }
        }
    }

    if (index < 0 || !proxies[index])
    {
        if (lastServer != 3)
        {
            index = ++lastServer;
        } else
        {
            index = 0;
        }
    }

    // If the selected server is down, select one that isn't down.
    if (proxies[index].options.down)
    {
        index = -1;

        var tries = 0;
        while (tries < 5 && index < 0)
        {
            var nextIndex = index + 1;
            if (!proxies[nextIndex].options.down)
            {
                index = nextIndex;
            }
            tries++;
        }
    }

    index = index >= 0 ? index : 0;

    // Store the server index as a sticky session.
    if (res)
    {
        res.setHeader('Set-Cookie', 'server=' + index + '; path=/');
    }

    return index;
};

var startFailoverTimer = function (index)
{
    if (failoverTimer[index])
    {
        return;
    }

    failoverTimer[index] = setTimeout(function ()
    {
        // Check if the server is up or not
        request({
            url: proxies[index].options.target,
            method: 'HEAD',
            timeout: 10000
        }, function (err, res, body)
        {
            failoverTimer[index] = null;

            if (res && res.statusCode === 200)
            {
                proxies[index].options.down = false;
                console.log('Server #' + index + ' is back up.');
            } else
            {
                proxies[index].options.down = true;
                startFailoverTimer(index);
                console.log('Server #' + index + ' is still down.');
            }
        });
    }, 10000);
};

var serverCallback = function (req, res)
{
    var proxyIndex = selectServer(req, res);
    var proxy = proxies[proxyIndex];
    proxy.web(req, res);

    proxy.on('error', function (err)
    {
        startFailoverTimer(proxyIndex);
    });
};
var server = http.createServer(serverCallback);

server.on('upgrade', function (req, socket, head)
{
    var proxyIndex = selectServer(req);
    var proxy = proxies[proxyIndex];
    proxy.ws(req, socket, head);

    proxy.on('error', function (err, req, socket)
    {
        socket.end();
        startFailoverTimer(proxyIndex);
    });
});
console.log("LoadBalancer is listening on port ", port);
server.listen(port);