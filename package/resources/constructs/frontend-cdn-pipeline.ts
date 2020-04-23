import { pascalCase, paramCase } from 'change-case';
import { IFrontendEnvironment, IBasePipelineProps } from '../interfaces';
import { Construct } from '@aws-cdk/core';
import { Bucket } from '@aws-cdk/aws-s3';
import {
  CloudFrontWebDistribution,
  ViewerCertificate,
  SecurityPolicyProtocol,
  SSLMethod,
  OriginAccessIdentity,
  ViewerProtocolPolicy,
} from '@aws-cdk/aws-cloudfront';
import { DnsValidatedCertificate } from '@aws-cdk/aws-certificatemanager';
import { BasePipeline } from './base-pipeline';
import { S3DeployAction } from '@aws-cdk/aws-codepipeline-actions';
import { DOMAIN_NAME_REGISTRAR } from '../constants/enums';
import { CnameRecord, IHostedZone } from '@aws-cdk/aws-route53';

interface IFrontendCDNPipelineProps
  extends IBasePipelineProps<IFrontendEnvironment> {
  certificate: DnsValidatedCertificate;
  hostedZone: IHostedZone;
}

export class FrontendCDNPipeline extends BasePipeline {
  constructor(scope: Construct, id: string, props: IFrontendCDNPipelineProps) {
    super(scope, id, {
      artifactSourceKey: props.artifactsSourceKey,
      notificationsType: props.notificationsType,
    });
    const { environments, certificate, hostedZone } = props;

    // create distribution for each environment
    environments.forEach(environment => {
      const {
        aliases,
        name,
        approvalRequired,
        cloudfrontPriceClass,
        defaultRootObject,
        errorRootObject,
        domainNameRegistrar,
      } = environment;
      const s3BucketSource = new Bucket(
        this,
        pascalCase(name + 'OriginBucket')
      );
      const originAccessIdentity = new OriginAccessIdentity(
        this,
        pascalCase(`${name}OriginAccessIdentity`),
        {
          comment: `Origin Access Identity for ${aliases[0]}`,
        }
      );

      const distribution = new CloudFrontWebDistribution(
        this,
        pascalCase(`${name}WebDistribution`),
        {
          originConfigs: [
            {
              s3OriginSource: { s3BucketSource, originAccessIdentity },
              behaviors: [
                {
                  isDefaultBehavior: true,
                  forwardedValues: {
                    queryString: true,
                    cookies: {
                      forward: 'none',
                    },
                  },
                },
              ],
            },
          ],

          defaultRootObject: defaultRootObject || 'index.html',
          errorConfigurations: [
            // we let out apps handle error redirection
            {
              errorCode: 200,
              responsePagePath: errorRootObject || 'index.html',
            },
          ],
          comment: `Cloudfront Distribution for ${aliases[0]}`,
          priceClass: cloudfrontPriceClass,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          viewerCertificate: ViewerCertificate.fromAcmCertificate(certificate, {
            securityPolicy: SecurityPolicyProtocol.TLS_V1_2_2018,
            sslMethod: SSLMethod.SNI,
            aliases: aliases,
          }),
        }
      );

      // register record in route53
      if (domainNameRegistrar === DOMAIN_NAME_REGISTRAR.AWS) {
        new CnameRecord(this, pascalCase(`${name}CnameRecord`), {
          zone: hostedZone,
          recordName: aliases[0],
          domainName: distribution.domainName,
        });
      }
      // create deploy actions
      const actions = [];
      let runOrder = 0;
      if (approvalRequired) {
        actions.push(
          this.createManualApprovalAction({
            actionName: 'Approve',
            runOrder: ++runOrder,
          })
        );
      }

      actions.push(
        new S3DeployAction({
          bucket: s3BucketSource,
          input: this.checkoutSource,
          actionName: 'Deploy',
          extract: true,
          objectKey: name,
          runOrder: ++runOrder,
        })
      );

      this.pipeline.addStage({
        actions,
        stageName: pascalCase(`${name}Deploy`),
      });
    });
  }
}