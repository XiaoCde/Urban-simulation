# -*-coding:utf-8 -*-
# python 3.9
# 比较21个城市的人口在current和ssp585

"""
# @File       : 12_SSP_pop_compar.py
# @software   : PyCharm  
# @Time       ：2025/6/5 11:51
# @Author     ：Wei Lyu
"""

import pandas as pd
import matplotlib.pyplot as plt
import numpy as np
import os

plt.rcParams['pdf.fonttype'] = 42
plt.rcParams['font.family'] = 'Arial'

if __name__ == '__main__':
    # 设置路径
    outputPath = 'D:/LW/ABM/OutputData'
    base_path_current = os.path.join(outputPath, 'Result/cities_21_max')
    base_path_ssp = os.path.join(outputPath, 'Result_SSP585_pop2/cities_21_max')
    cities_info_path = os.path.join(outputPath, 'cities_21/cities21_pop_CH.csv')

    # 读取城市列表
    relation = pd.read_csv(cities_info_path, header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    cities = ['北京市', '成都市', '重庆市', '大连市', '东莞市', '上海市', '青岛市', '杭州市', '哈尔滨市', '郑州市', '深圳市', '西安市', '长沙市', '武汉市',
              '佛山市', '济南市', '沈阳市', '广州市', '天津市', '昆明市', '南京市']

    positions = [cities_cn.index(element) for element in cities]

    cities_cn = [cities_cn[ind] for ind in positions]

    cities_en = [cities_en[ind][:-3] for ind in positions]
    for i in range(len(cities_en)):
        if cities_en[i] == 'xian':
            cities_en[i] = 'xi\'an'
        if cities_en[i] == 'haerbin':
            cities_en[i] = 'harbin'

    # 初始化数据
    current_pops = []
    ssp_pops = []

    # 读取每个城市的Con_pop总和
    for city_cn in cities_cn:
        path_current = os.path.join(base_path_current, city_cn, 'model_input.csv')
        path_ssp = os.path.join(base_path_ssp, city_cn, 'model_input.csv')

        try:
            df_current = pd.read_csv(path_current)
            df_ssp = pd.read_csv(path_ssp)
            current_pops.append(df_current['Con_pop'].sum())
            ssp_pops.append(df_ssp['Con_pop'].sum())
        except:
            current_pops.append(0)
            ssp_pops.append(0)

    # 绘图数据准备
    df = pd.DataFrame({'City': [city.capitalize() for city in cities_en], 'Current': current_pops, 'SSP585': ssp_pops})
    df.set_index('City', inplace=True)

    # 设置颜色
    color_current = '#DBEAD8'
    color_ssp = '#6EB9C3'

    # 绘制横向双柱状图
    fig, ax = plt.subplots(figsize=(12, 5))
    x = np.arange(len(df)) * 3.5   # 间距增加
    bar_width = 1

    ax.bar(x - bar_width / 2, df['Current'], width=bar_width, label='Current', color=color_current, edgecolor='black')
    ax.bar(x + bar_width / 2, df['SSP585'], width=bar_width, label='SSP5-8.5', color=color_ssp, edgecolor='black')

    ax.set_xticks(x)
    ax.set_xticklabels(df.index, rotation=45, ha='right', fontsize=12)
    ax.set_xlabel('Cities', fontsize=14)
    ax.set_ylabel('Population', fontsize=14)
    ax.legend()

    # 去掉右框线和上框线
    ax.spines['right'].set_visible(False)
    ax.spines['top'].set_visible(False)

    plt.tight_layout()
    plt.savefig(r'D:\LW\ABM\OutputData\Result_SSP585_pop2\pic\sigma=1' + '\\' + 'pop_comparison.pdf')
    plt.show()