const https = require('https');
const http = require('http');

module.exports = async (req, res) => {
    try {
        // 1. 解析混淆解密目标 URL
        const pathParts = req.url.split('/proxy/');
        if (pathParts.length < 2) {
            return res.status(400).send('错误：无效的代理请求');
        }

        const rawHex = pathParts[1].split('?')[0];
        let targetUrlStr = '';
        for (let i = 0; i < rawHex.length; i += 2) {
            targetUrlStr += String.fromCharCode(parseInt(rawHex.substr(i, 2), 16));
        }

        if (!targetUrlStr.startsWith('http')) {
            targetUrlStr = 'https://' + targetUrlStr;
        }

        const targetUrl = new URL(targetUrlStr);
        const customHost = req.headers.host;

        // 2. 伪造全套纯净高净值请求头
        let newHeaders = {};
        for (let key in req.headers) {
            if (!key.startsWith('cf-') && !key.startsWith('x-') && !['host', 'cookie', 'referer'].includes(key)) {
                newHeaders[key] = req.headers[key];
            }
        }
        
        newHeaders['host'] = targetUrl.host;
        newHeaders['referer'] = targetUrl.origin + '/';
        newHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        newHeaders['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8';

        // 3. 构建中转连接器
        const clientOptions = {
            method: req.method,
            headers: newHeaders,
            timeout: 15000
        };

        const requester = targetUrl.protocol === 'https:' ? https : http;

        const proxyReq = requester.request(targetUrl.href, clientOptions, (proxyRes) => {
            let responseHeaders = {};
            for (let key in proxyRes.headers) {
                // 洗白 CSP 安全锁、反 Frame 锁，确保能在沙箱内无缝内嵌
                if (!['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'clear-site-data'].includes(key)) {
                    responseHeaders[key] = proxyRes.headers[key];
                }
            }

            // 处理内部重定向重写，防止目标网站跳出沙箱浏览器
            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
                let redirectLocation = proxyRes.headers['location'];
                if (redirectLocation) {
                    let resolvedRedirect = new URL(redirectLocation, targetUrl.href).href;
                    let hexRedirect = '';
                    for (let i = 0; i < resolvedRedirect.length; i++) {
                        hexRedirect += resolvedRedirect.charCodeAt(i).toString(16).padStart(2, '0');
                    }
                    res.writeHead(proxyRes.statusCode, {
                        'Location': `https://${customHost}/proxy/${hexRedirect}`,
                        'Access-Control-Allow-Origin': '*'
                    });
                    return res.end();
                }
            }

            // 跨域清洗
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            
            const contentType = proxyRes.headers['content-type'] || '';

            // 如果是网页 HTML 资源，进行深度流式“链接与域名洗白”，强行让网页内的所有子链自动走本代理
            if (contentType.includes('text/html')) {
                let bodyBuffer = [];
                proxyRes.on('data', (chunk) => bodyBuffer.push(chunk));
                proxyRes.on('end', () => {
                    let htmlContent = Buffer.concat(bodyBuffer).toString('utf-8');
                    
                    // 核心拦截替换脚本：让页面内所有的静态资源请求、异步请求、点击请求全面代理化
                    const injectInterceptorScript = `
                    <script>
                        (function() {
                            const customHost = "${customHost}";
                            const targetOrigin = "${targetUrl.origin}";
                            
                            function toHex(str) {
                                let hex = '';
                                for(let i=0; i<str.length; i++) { hex += str.charCodeAt(i).toString(16).padStart(2, '0'); }
                                return hex;
                            }
                            
                            // 动态重写所有 A 标签
                            function cleanLinks() {
                                document.querySelectorAll('a').forEach(a => {
                                    if(a.href && !a.href.includes(customHost) && a.href.startsWith('http')) {
                                        a.href = window.location.origin + '/proxy/' + toHex(a.href);
                                    }
                                });
                                document.querySelectorAll('form').forEach(f => {
                                    if(f.action && !f.action.includes(customHost)) {
                                        let fullAction = new URL(f.action, targetOrigin).href;
                                        f.action = window.location.origin + '/proxy/' + toHex(fullAction);
                                    }
                                });
                            }
                            
                            // 动态拦截全网页的网络劫持对象 (Fetch & XHR)
                            const origFetch = window.fetch;
                            window.fetch = async function(...args) {
                                if(typeof args[0] === 'string' && !args[0].includes(customHost) && args[0].startsWith('http')) {
                                    args[0] = window.location.origin + '/proxy/' + toHex(args[0]);
                                }
                                return origFetch.apply(this, args);
                            };
                            
                            setInterval(cleanLinks, 1500);
                            window.addEventListener('DOMContentLoaded', cleanLinks);
                        })();
                    </script>
                    `;
                    
                    // 实施动态置换
                    htmlContent = htmlContent.replace(/href="\/search/g, `href="https://${customHost}/proxy/`);
                    htmlContent = htmlContent.replace('</body>', injectInterceptorScript + '</body>');
                    
                    res.writeHead(proxyRes.statusCode, responseHeaders);
                    res.end(htmlContent);
                });
            } else {
                // 如果是图片、JS、CSS 媒体流等，不作修改，直接用高性能管道极速透传
                res.writeHead(proxyRes.statusCode, responseHeaders);
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (e) => {
            res.status(502).send('高级隧道建立失败，边缘节点连接超时: ' + e.message);
        });

        // 写入请求体（处理 POST 请求数据）
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }

    } catch (err) {
        res.status(500).send('云端沙箱虚拟机内部致命错误: ' + err.message);
    }
};
