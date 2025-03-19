import express from "express";
import axios from "axios";
import { exec } from "child_process";
import fs from "fs";
import { createObjectCsvWriter as createCsvWriter } from "csv-writer";

const app = express();
const PORT = 3000;
const PROMETHEUS_URL = "http://localhost:9090/api/v1/query";

const csvWriter = createCsvWriter({
  path: "k8s_metrics.csv",
  header: [
    { id: "timestamp", title: "Timestamp" },
    { id: "network_latency", title: "Network Latency" },
    { id: "packet_loss", title: "Packet Loss" },
    { id: "node_status", title: "Node Status" },
    { id: "disk_io", title: "Disk I/O" },
    { id: "cpu_load", title: "CPU Load" },
    { id: "api_latency", title: "API Latency" },
    { id: "request_errors", title: "Request Errors" }
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

// Function to query Prometheus
async function queryPrometheus(query) {
  try {
    const response = await axios.get(PROMETHEUS_URL, { params: { query } });
    return response.data.data.result.length > 0 ? response.data.data.result[0].value[1] : null;
  } catch (error) {
    return null;
  }
}

// Collect Kubernetes & Prometheus Metrics
async function collectMetrics() {
  const timestamp = new Date().toISOString();
  const network_latency = await queryPrometheus("histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))");
  const packet_loss = await queryPrometheus("rate(node_network_receive_drop_total[5m])");
  const node_status = await runCommand("kubectl get nodes -o wide");
  const disk_io = await queryPrometheus("node_disk_io_time_seconds_total");
  const cpu_load = await queryPrometheus("node_load1");
  const api_latency = await queryPrometheus("histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))");
  const request_errors = await queryPrometheus('sum(rate(http_requests_total{status=~"5.."}[5m]))');

  const row = {
    timestamp,
    network_latency,
    packet_loss,
    node_status,
    disk_io,
    cpu_load,
    api_latency,
    request_errors
  };

  await csvWriter.writeRecords([row]);
  console.log("Metrics collected and saved!");
}

// 1️⃣ Endpoint to trigger failure simulation
app.get("/simulate-failures", (req, res) => {
  exec("./simulate_failures.sh", (error, stdout) => {
    if (error) {
      res.status(500).send("Failed to simulate failures.");
    } else {
      console.log(error)
      res.send("Failures simulated successfully!");
    }
  });
});

// 2️⃣ Endpoint to collect metrics
app.get("/collect-metrics", async (req, res) => {
  await collectMetrics();
  res.send("Metrics collected and stored in CSV.");
});

// 3️⃣ Endpoint to schedule continuous metric collection
app.get("/keepcollecting-metrics", (req, res) => {
  const interval = setInterval(async () => {
    await collectMetrics();
  }, 60000); 

  res.send("Scheduled continuous metric collection.");
})


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
