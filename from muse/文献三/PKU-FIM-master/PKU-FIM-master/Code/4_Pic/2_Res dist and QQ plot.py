# -*-coding:utf-8 -*-
# python 3.9
# 统计误差直方图和QQ plot

"""
# @File       : 2_Res dist and QQ plot.py
# @software   : PyCharm  
# @Time       ：2025/4/28 10:45
# @Author     ：Wei Lyu
"""

import numpy as np
import matplotlib.pyplot as plt
import pandas as pd
import scipy.stats as stats
import seaborn as sns
import pylab
import warnings
from matplotlib import MatplotlibDeprecationWarning

warnings.filterwarnings("ignore", category=MatplotlibDeprecationWarning)

plt.rcParams['pdf.fonttype'] = 42 


if __name__ == '__main__':
    path = 'D:/LW/ABM'

    outputPath = path + '/OutputData'

    sigma = 1
    granularity = '1km'
    flow_type = 'inflow'
    shelter_weight = 0.1

    colors = ['#566998', '#C87D8C']


    for i, city in enumerate(['zhengzhou', 'shenzhen']):
        basePath = outputPath + '/Result/' + city + '/' + 'shelter weight-' + str(shelter_weight) + '/' + granularity
        storagePath = basePath + '/sigma=' + str(sigma)
        pic_storagePath = basePath + '/pic/sigma=' + str(sigma)

        flow_pred_ave = np.load(storagePath + '/' + flow_type + 'Pred_Map.npy')

        flow_dur_aveHour_map = np.load(storagePath + '/' + flow_type + 'GroundTruth_Map.npy')
        groundTruth = np.load(storagePath + '/' + flow_type + 'GroundTruth_LabelMap.npy')

        # 先读数据，处理数据
        pre = flow_pred_ave[-1]
        tru = flow_dur_aveHour_map

        # 边界外，bbox内位置
        mask = np.isnan(groundTruth)

        # norm
        tru1 = (tru - np.nanmin(tru)) / (np.nanmax(tru) - np.nanmin(tru))
        pre1 = (pre - np.nanmin(pre)) / (np.nanmax(pre) - np.nanmin(pre))

        errors = tru1 - pre1
        errors = errors[~np.isnan(errors)].tolist()

        # # 创建画布
        fig, ax = plt.subplots()

        # 画直方图（不含kde）
        sns.histplot(errors, bins=50, color=colors[i], edgecolor='k', kde=True, label='Histogram')

        # 单独画KDE，并设置label
        sns.kdeplot(errors, color=colors[i], linewidth=0, label='KDE Curve')    # 为了图例

        # 添加参考线：误差=0的位置
        # plt.axvline(x=0, color='#CE4B53', linestyle='--', linewidth=2, label='Zero Error')

        # 图表设置
        plt.title('Residual Distribution', fontsize=16)
        plt.xlabel('Prediction Residuals', fontsize=14)
        plt.ylabel('Frequency', fontsize=14)
        plt.tick_params(axis='both', labelsize=12)

        plt.title(city)
        plt.legend()
        plt.grid(False)
        ax.spines['right'].set_visible(False)
        ax.spines['top'].set_visible(False)

        # 显示图
        plt.savefig(pic_storagePath + '/Res_dist.png', dpi=300)
        plt.savefig(pic_storagePath + '/Res_dist.pdf')
        plt.show()
        plt.close()




        # # 画Q-Q图 --------------------------------------------------------------
        # plt.subplots(figsize=(8, 8))
        # res = stats.probplot(errors, dist="norm")
        #
        # # 拆出数据
        # osm = res[0][0]  # theoretical quantiles (x轴)
        # osr = res[0][1]  # ordered sample (y轴)
        # slope, intercept, r = res[1][0], res[1][1], res[1][2]  # 拟合线参数
        #
        # r_squared = r ** 2
        #
        # n = len(osr)
        # confidence = 95
        # num_simulations = 1000
        # alpha = (100 - confidence) / 2
        #
        # # 生成模拟数据并计算分位数
        # simulated_quantiles = np.zeros((num_simulations, n))
        # for j in range(num_simulations):
        #     sim_sample = np.random.normal(loc=intercept, scale=slope, size=n)
        #     simulated_quantiles[j, :] = np.sort(sim_sample)
        #
        # # 计算置信区间上下界
        # lower = np.percentile(simulated_quantiles, alpha, axis=0)
        # upper = np.percentile(simulated_quantiles, 100 - alpha, axis=0)
        #
        # plt.fill_between(osm, lower, upper, color='lightgray', alpha=0.5, label='95% CI', zorder=1)
        # plt.plot(osm, slope * osm + intercept, color='k', linewidth=2, label=f'y = ${intercept:.2f}$' + f' + ${slope:.2f}$x', zorder=2)  # 线的颜色和粗细
        # plt.scatter(osm, osr, color=colors[i], edgecolor=colors[i], facecolors='none', label='Value', s=30, zorder=3)  # 点的颜色
        #
        #
        # plt.legend()
        # plt.xlabel('Theoretical Quantiles', fontsize=16)
        # plt.ylabel('Observed Quantiles', fontsize=16)
        # plt.tick_params(axis='both', labelsize=14)
        # plt.title('Q-Q Plot', fontsize=18)
        #
        # # 打印R²到图上
        # plt.text(0.1, 0.1, f'$R^2 = {r_squared:.2f}$',
        #         transform=ax.transAxes,
        #         fontsize=16)
        #
        # plt.savefig(pic_storagePath + '/Res_QQ plot.png', dpi=300)
        # plt.savefig(pic_storagePath + '/Res_QQ plot.pdf')
        # plt.close()

