import express from "express";
import axios from "axios";
import { exec } from "child_process";
import fs from "fs";
import { createObjectCsvWriter as createCsvWriter } from "csv-writer";

const app = express();
const PORT = 3001;
const PROMETHEUS_URL = "http://localhost:9090/api/v1/query";

const csvWriter = createCsvWriter({
  path: "k8s_metrics.csv",
  header: [
    { id: "podName", title: "Pod Name" },
    { id: "timestamp", title: "Timestamp" },
    { id: "memory_usage", title: "Memory Usage" },
    { id: "network_latency", title: "Network Latency" },
    { id: "packet_loss", title: "Packet Loss" },
    { id: "node_status", title: "Node Status" },
    { id: "disk_io", title: "Disk I/O" },
    { id: "cpu_load", title: "CPU Load" },
    { id: "api_latency", title: "API Latency" },
    { id: "request_errors", title: "Request Errors" },
    { id: "restart_count", title: "Restart Count" }
  ]
});

// Function to execute shell commands
function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout) => {
      if (error) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// Helper function to get detailed pod status
async function getDetailedPodStatus(podName) {
  // First try to get termination reason
  let terminatedReason = await runCommand(
    `kubectl get pod ${podName} -o jsonpath="{.status.containerStatuses[0].state.terminated.reason}"`
  );
  if (terminatedReason && terminatedReason !== "null" && terminatedReason !== "") {
    return terminatedReason;
  }

  // Next try to get waiting reason
  let waitingReason = await runCommand(
    `kubectl get pod ${podName} -o jsonpath="{.status.containerStatuses[0].state.waiting.reason}"`
  );
  if (waitingReason && waitingReason !== "null" && waitingReason !== "") {
    return waitingReason;
  }

  // Fallback to the overall pod phase
  return await runCommand(`kubectl get pod ${podName} -o jsonpath="{.status.phase}"`);
}

// Function to query Prometheus
async function queryPrometheus(query) {
  try {
    const response = await axios.get(`${PROMETHEUS_URL}?query=${encodeURIComponent(query)}`);
    // Check if there are results and return the value
    return response.data.data.result.length > 0 ? response.data.data.result[0].value[1] : null;
  } catch (error) {
    return null;
  }
}

async function collectMetrics() {
  const timestamp = new Date().toISOString();
  const podNames = await runCommand(`kubectl get pods --no-headers -o custom-columns=NAME:.metadata.name`);
  const pods = podNames.split('\n');

  for (const podName of pods) {
    if (podName.split("-")[0] !== 'createpod') continue; 

    // Get detailed pod status (OOMKilled, CrashLoopBackOff, etc.)
    const node_status = await getDetailedPodStatus(podName);

    // Retrieve metrics from Prometheus
    const network_latency = await queryPrometheus(`histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{pod="${podName}"}[1m]))`);
    const packet_loss = await queryPrometheus(`increase(node_network_receive_drop_total{pod="${podName}"}[1m])`);
    const memory_usage = await queryPrometheus(`container_memory_usage_bytes{pod="${podName}"}`);
    const cpu_load = await queryPrometheus(`rate(container_cpu_usage_seconds_total{pod="${podName}"}[1m])`);
    const api_latency = await queryPrometheus(`increase(prometheus_http_request_duration_seconds_count[1m])`);
    const request_errors = await queryPrometheus(`increase(prometheus_http_requests_total{pod="prometheus-monitoring-kube-prometheus-prometheus-0", code=~"5.."}[1m])`);
    const disk_io = await queryPrometheus(`increase(node_disk_io_time_seconds_total{pod="${podName}"}[1m])`);
    const restart_count = await runCommand(`kubectl get pod ${podName} -o jsonpath="{.status.containerStatuses[0].restartCount}"`);

    const row = {
      podName,
      timestamp,
      memory_usage,
      network_latency,
      packet_loss,
      node_status,
      disk_io,
      cpu_load,
      api_latency,
      request_errors,
      restart_count
    };
    
    console.log(row);
    await csvWriter.writeRecords([row]);
    console.log(`Metrics collected and saved for ${podName}!`);
  }
}

app.listen(PORT, async () => {
  await collectMetrics();
  setInterval(async () => {
    await collectMetrics();
    console.log("Metrics collecting");
  }, 5000);
  console.log(`Server running on http://localhost:${PORT}`);
});
