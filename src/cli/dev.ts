#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { exit } from 'node:process';

interface CliArgs {
  project: string;
  port: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let project: string | undefined;
  let port = 51234; // Default port

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--project' && i + 1 < args.length) {
      project = args[i + 1];
      i++; // Skip next argument
    } else if (arg === '--port' && i + 1 < args.length) {
      const portStr = args[i + 1];
      const parsedPort = parseInt(portStr, 10);
      if (isNaN(parsedPort) || parsedPort <= 0) {
        console.error('Error: --port must be a positive integer');
        exit(1);
      }
      port = parsedPort;
      i++; // Skip next argument
    }
  }

  if (!project) {
    console.error('Error: --project is required');
    console.error('Usage: bun run src/cli/dev.ts --project <project-path> [--port <port>]');
    exit(1);
  }

  return { project, port };
}

function spawnProcess(command: string, args: string[], description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Starting ${description}...`);
    
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true
    });

    child.on('error', (error) => {
      console.error(`Failed to start ${description}:`, error.message);
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        console.log(`${description} killed by signal: ${signal}`);
      } else if (code !== 0) {
        console.log(`${description} exited with code: ${code}`);
      } else {
        console.log(`${description} exited successfully`);
      }
      resolve();
    });
  });
}

async function main() {
  const { project, port } = parseArgs();
  
  console.log(`Starting dev servers for project: ${project}`);
  console.log(`API port: ${port}`);

  const apiArgs = ['run', 'src/server/dev.ts', '--', '--project', project, '--port', port.toString()];
  const uiArgs = ['run', 'dev:ui'];

  const apiServer = spawn('bun', apiArgs, {
    stdio: 'inherit',
    shell: true
  });

  const uiServer = spawn('bun', uiArgs, {
    stdio: 'inherit',
    shell: true
  });

  // Handle signals and clean up both processes
  const cleanup = () => {
    console.log('\nShutting down servers...');
    apiServer.kill('SIGTERM');
    uiServer.kill('SIGTERM');
    
    // Force kill if they don't terminate gracefully
    setTimeout(() => {
      apiServer.kill('SIGKILL');
      uiServer.kill('SIGKILL');
      exit(0);
    }, 5000);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Wait for either process to exit
  let apiExited = false;
  let uiExited = false;

  const handleExit = (processName: string) => {
    if (processName === 'API') {
      apiExited = true;
    } else {
      uiExited = true;
    }

    if (apiExited || uiExited) {
      console.log(`${processName} server exited, shutting down the other server...`);
      cleanup();
    }
  };

  apiServer.on('exit', (code, signal) => {
    if (signal) {
      console.log(`API server killed by signal: ${signal}`);
    } else if (code !== 0) {
      console.log(`API server exited with code: ${code}`);
    }
    handleExit('API');
  });

  uiServer.on('exit', (code, signal) => {
    if (signal) {
      console.log(`UI server killed by signal: ${signal}`);
    } else if (code !== 0) {
      console.log(`UI server exited with code: ${code}`);
    }
    handleExit('UI');
  });

  apiServer.on('error', (error) => {
    console.error('Failed to start API server:', error.message);
    cleanup();
    exit(1);
  });

  uiServer.on('error', (error) => {
    console.error('Failed to start UI server:', error.message);
    cleanup();
    exit(1);
  });

  console.log('Both servers started successfully');
  console.log(`API server: http://127.0.0.1:${port}`);
  console.log('UI server: check Vite output for URL');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  exit(1);
});