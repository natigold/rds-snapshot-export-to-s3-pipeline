import * as cdk from "@aws-cdk/core";
import * as path from "path";
import {CfnCrawler} from "@aws-cdk/aws-glue";
import {ManagedPolicy, PolicyDocument, Role, ServicePrincipal, AccountRootPrincipal} from "@aws-cdk/aws-iam";
import {Code, Function, Runtime} from "@aws-cdk/aws-lambda";
import {SnsEventSource} from "@aws-cdk/aws-lambda-event-sources";
import {Key} from "@aws-cdk/aws-kms";
import {CfnEventSubscription} from "@aws-cdk/aws-rds";
import {BlockPublicAccess, Bucket} from "@aws-cdk/aws-s3";
import {Topic} from "@aws-cdk/aws-sns";

export enum RdsEventId {
  /**
   * Event IDs for which the Lambda supports starting a snapshot export task.
   * 
   * Note that with AWS Backup service, the service triggers a Manual snapshot created event (instead of automated),
   * where a new snapshot is created, or a finished copy notification when a prior snapshot of the same DB has been taken recently. 
   *
   * See:
   *   https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_Events.Messages.html#USER_Events.Messages.cluster-snapshot
   *   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_Events.Messages.html#USER_Events.Messages.snapshot
   *   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html 
   */
  // For automated snapshots of Aurora RDS clusters
  DB_AUTOMATED_AURORA_SNAPSHOT_CREATED = "RDS-EVENT-0169",

  // For automated snapshots of non-Aurora RDS clusters
  DB_AUTOMATED_SNAPSHOT_CREATED = "RDS-EVENT-0091",

  // For manual snapshots and backup service snapshots of non-Aurora RDS clusters
  DB_MANUAL_SNAPSHOT_CREATED = "RDS-EVENT-0042",

  // For backup service snapshots copying ()
  DB_BACKUP_SNAPSHOT_FINISHED_COPY = "RDS-EVENT-0197",
}

export enum RdsSnapshotType {
  /**
   * Snapshot Types supported by the Lambda. Each RdsEventId used should correlate with the corresponsing snapshot type.
   * For instance: Automated snapshot event ID should be configured to work with Automated snapshot type
   * 
   * See:
   *  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html#AutomatedBackups.AWSBackup
   *  
   */
  // For automated snapshots (system snapshots)
  DB_AUTOMATED_SNAPSHOT = "AUTOMATED",

  // For Backup service snapshots 
  DB_BACKUP_SNAPSHOT = "BACKUP",

  // For Backup service snapshots 
  DB_MANUAL_SNAPSHOT = "MANUAL"
}

export interface RdsSnapshot {
  rdsEventId: RdsEventId;
  rdsSnapshotType: RdsSnapshotType;
}

export interface RdsSnapshotExportPipelineStackProps extends cdk.StackProps {
  /**
   * Name of the S3 bucket to which snapshot exports should be saved.
   *
   * NOTE: Bucket will be created if one does not already exist.
   */
  readonly s3BucketName: string;

  /**
   * Name of the database cluster whose snapshots the function supports exporting.
   */
  readonly dbName: string;

  /**
   * The RDS event ID and snapshot type for which the function should be triggered.
   */
  readonly rdsEvents: Array<RdsSnapshot>;
};

export class RdsSnapshotExportPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: RdsSnapshotExportPipelineStackProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, "SnapshotExportBucket", {
      bucketName: props.s3BucketName,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    const snapshotExportTaskRole = new Role(this, "SnapshotExportTaskRole", {
      assumedBy: new ServicePrincipal("export.rds.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
      inlinePolicies: {
        "SnapshotExportTaskPolicy": PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Action": [
                "s3:PutObject*",
                "s3:ListBucket",
                "s3:GetObject*",
                "s3:DeleteObject*",
                "s3:GetBucketLocation"
              ],
              "Resource": [
                `${bucket.bucketArn}`,
                `${bucket.bucketArn}/*`,
              ],
              "Effect": "Allow"
            }
          ],
        })
      }
    });

    const lambdaExecutionRole = new Role(this, "RdsSnapshotExporterLambdaExecutionRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: 'RdsSnapshotExportToS3 Lambda execution role for the "' + props.dbName + '" database.',
      inlinePolicies: {
        "SnapshotExporterLambdaPolicy": PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Action": "rds:StartExportTask",
              "Resource": "*",
              "Effect": "Allow",
            },
            {
              "Action": "iam:PassRole",
              "Resource": [snapshotExportTaskRole.roleArn],
              "Effect": "Allow",
            },
            {
              "Action": "backup:DescribeBackupJob",
              "Resource": "*",
              "Effect": "Allow",
            }
          ]
        })
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    const snapshotExportGlueCrawlerRole = new Role(this, "SnapshotExportsGlueCrawlerRole", {
      assumedBy: new ServicePrincipal("glue.amazonaws.com"),
      description: "Role used by RDS to perform snapshot exports to S3",
      inlinePolicies: {
        "SnapshotExportsGlueCrawlerPolicy": PolicyDocument.fromJson({
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Action": [
                "s3:GetObject",
                "s3:PutObject"
              ],
              "Resource": `${bucket.bucketArn}/*`,
            }
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"),
      ],
    });

    const snapshotExportEncryptionKey = new Key(this, "SnapshotExportEncryptionKey", {
      alias: props.dbName + "-snapshot-exports",
      policy: PolicyDocument.fromJson({
        "Version": "2012-10-17",
        "Statement": [
          {
            "Principal": {
              "AWS": [
                (new AccountRootPrincipal()).arn,
                lambdaExecutionRole.roleArn,
                snapshotExportGlueCrawlerRole.roleArn
              ]
            },
            "Action": [
              "kms:Encrypt",
              "kms:Decrypt",
              "kms:ReEncrypt*",
              "kms:GenerateDataKey*",
              "kms:DescribeKey"
            ],
            "Resource": "*",
            "Effect": "Allow",
          },
          {
            "Principal": lambdaExecutionRole.roleArn,
            "Action": [
              "kms:CreateGrant",
              "kms:ListGrants",
              "kms:RevokeGrant"
            ],
            "Resource": "*",
            "Condition": {
                "Bool": {"kms:GrantIsForAWSResource": true}
            },
            "Effect": "Allow",
          }
        ]
      })
    });

    const snapshotEventTopic = new Topic(this, "SnapshotEventTopic", {
      displayName: "rds-snapshot-creation"
    });

    // Creates the appropriate RDS Event Subscription for RDS or Aurora clusters, to catch snapshot creation events 
    props.rdsEvents.find(rdsEvent => 
      rdsEvent.rdsEventId == RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED) ? 
        new CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
          snsTopicArn: snapshotEventTopic.topicArn,
          enabled: true,
          eventCategories: ['backup'],
          sourceType: 'db-cluster-snapshot',
        }) :
        new CfnEventSubscription(this, 'RdsSnapshotEventNotification', {
          snsTopicArn: snapshotEventTopic.topicArn,
          enabled: true,
          eventCategories: ['creation'],
          sourceType: 'db-snapshot',
        }
      );

    // With AWS Backup Service, if a prior recent snapshot exists (if created by the Automated snapshot) 
    // the serivce will simply copy the existing snapshot, and trigger another notification  
    props.rdsEvents.find(rdsEvent => 
      rdsEvent.rdsEventId == RdsEventId.DB_BACKUP_SNAPSHOT_FINISHED_COPY) ? 
        new CfnEventSubscription(this, 'RdsBackupCopyEventNotification', {
          snsTopicArn: snapshotEventTopic.topicArn,
          enabled: true,
          eventCategories: ['notification'],
          sourceType: 'db-snapshot',
        }
      ) : true;

    new Function(this, "LambdaFunction", {
      functionName: props.dbName + "-rds-snapshot-exporter",
      runtime: Runtime.PYTHON_3_8,
      handler: "main.handler",
      code: Code.fromAsset(path.join(__dirname, "/../assets/exporter/")),
      environment: {
        RDS_EVENT_IDS: new Array(props.rdsEvents.map(e => { return e.rdsEventId })).join(),
        RDS_SNAPSHOT_TYPES: new Array(props.rdsEvents.map(e => { return e.rdsSnapshotType })).join(),
        DB_NAME: props.dbName,
        LOG_LEVEL: "INFO",
        SNAPSHOT_BUCKET_NAME: bucket.bucketName,
        SNAPSHOT_TASK_ROLE: snapshotExportTaskRole.roleArn,
        SNAPSHOT_TASK_KEY: snapshotExportEncryptionKey.keyArn,
        DB_SNAPSHOT_TYPES: new Array(props.rdsEvents.map(e => { return e.rdsEventId == RdsEventId.DB_AUTOMATED_AURORA_SNAPSHOT_CREATED ? "cluster-snapshot" : "snapshot" })).join()
      },
      role: lambdaExecutionRole,
      timeout: cdk.Duration.seconds(30),
      events: [
        new SnsEventSource(snapshotEventTopic)
      ]
    });

    new CfnCrawler(this, "SnapshotExportCrawler", {
      name: props.dbName + "-rds-snapshot-crawler",
      role: snapshotExportGlueCrawlerRole.roleArn,
      targets: {
        s3Targets: [
          {path: bucket.bucketName},
        ]
      },
      databaseName: props.dbName.replace(/[^a-zA-Z0-9_]/g, "_"),
      schemaChangePolicy: {
        deleteBehavior: 'DELETE_FROM_DATABASE'
      }
    });
  }
}
