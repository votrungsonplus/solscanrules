const { bin, install } = require('cloudflared');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function startTunnel() {
    console.log('🚀 Starting Cloudflare Tunnel...');

    // 1. Ensure binary is installed
    try {
        if (!fs.existsSync(bin)) {
            console.log('📦 Installing cloudflared binary...');
            await install();
        }
    } catch (err) {
        console.error('❌ Failed to install cloudflared:', err.message);
        process.exit(1);
    }

    // 2. Start the tunnel
    // Port 3000 as defined in src/web/server.js
    const port = process.env.WEB_PORT || 3000;
    const tunnel = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`]);

    let urlFound = false;

    tunnel.stdout.on('data', (data) => {
        const output = data.toString();
        process.stdout.write(output);
        
        // Extract the .trycloudflare.com URL
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !urlFound) {
            console.log('\n' + '='.repeat(50));
            console.log('✅ PUBLIC ACCESS LINK CREATED:');
            console.log(`🔗 ${match[0]}`);
            console.log('='.repeat(50) + '\n');
            urlFound = true;
        }
    });

    tunnel.stderr.on('data', (data) => {
        const output = data.toString();
        process.stderr.write(output);
        
        // Some cloudflared versions log the URL to stderr
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !urlFound) {
            console.log('\n' + '='.repeat(50));
            console.log('✅ PUBLIC ACCESS LINK CREATED:');
            console.log(`🔗 ${match[0]}`);
            console.log('='.repeat(50) + '\n');
            urlFound = true;
        }
    });

    tunnel.on('close', (code) => {
        console.log(`Tunnel process exited with code ${code}`);
    });

    // Handle termination
    process.on('SIGINT', () => {
        tunnel.kill();
        process.exit();
    });
}

startTunnel().catch(err => {
    console.error('Fatal error starting tunnel:', err);
});
