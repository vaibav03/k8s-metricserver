#!/bin/bash
echo "Simulating Kubernetes Failures..."

# Network Issues: Limit network bandwidth (requires tc)
tc qdisc add dev eth0 root netem delay 200ms loss 5%

# ImagePullBackOff: Deploy a non-existent image
kubectl run bad-image --image=nonexistentrepo/doesnotexist

# CrashLoopBackOff: Create a pod that crashes
kubectl run crash-pod --image=busybox --restart=Always --command -- sh -c "exit 1"

# Node Failure: Drain a node
NODE=$(kubectl get nodes --no-headers | awk '{print $1}' | head -n 1)
kubectl drain $NODE --ignore-daemonsets --delete-local-data

# Service Unavailability: Kill a running pod
POD=$(kubectl get pods --no-headers | awk '{print $1}' | head -n 1)
kubectl delete pod $POD

echo "Failures simulated!"

